import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCaseId, createManifestV1, verifyManifestV1 } from '../dist/result-contract-v1.js';
import { auditedDgiSha } from '../dist/suite-catalog.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const marker = 'private-fixture-marker';
const start = Date.UTC(2026, 0, 1);
let installation, runs, cli, adaptDgiAllure;
before(async () => {
  installation = mkdtempSync(join(tmpdir(), 'qe-dgi-'));
  cpSync(new URL('../dist/', import.meta.url), join(installation, 'dist'), { recursive: true });
  cpSync(new URL('../package.json', import.meta.url), join(installation, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(installation, 'node_modules'));
  runs = join(installation, '.local', 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  ({ adaptDgiAllure } = await import(pathToFileURL(join(installation, 'dist/dgi-allure.js'))));
  ({ runCli: cli } = await import(pathToFileURL(join(installation, 'dist/run-cli.js'))));
});
after(() => rmSync(installation, { recursive: true, force: true }));

function fixture(layer = 'backend', statuses = ['passed']) {
  const id = randomUUID();
  const run = join(runs, id);
  const workspace = join(run, 'workspace');
  const directory = join(workspace, 'artifacts', 'allure-results', layer, 'unit');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const failed = statuses.some(status => ['failed', 'broken', 'unknown'].includes(status));
  const summary = { runId: id, suiteId: 'dgi-' + layer + '-unit', sourceRepository: 'delivery-geo-intelligence',
    commitSha: auditedDgiSha, runtimeVersion: 'v22.23.4',
    startedAt: new Date(start).toISOString(), endedAt: new Date(start + 1000).toISOString(), durationMs: 1000,
    phase: 'test', status: failed ? 'FAIL' : 'PASS', exitCode: failed ? 1 : 0, failureCategory: failed ? 'exit-nonzero' : null };
  const manifest = { schemaVersion: 1, layer, execution: 'unit', dataset: 'synthetic-only-v1', commit: auditedDgiSha,
    branch: 'unknown', ciRun: 'local', runtime: summary.runtimeVersion, environment: 'local', testExitCode: summary.exitCode,
    counts: {}, auditedAttachments: 0, omittedAttachments: 1, files: {} };
  const records = statuses.map((status, index) => {
    manifest.counts[status] = (manifest.counts[status] ?? 0) + 1;
    return { name: marker, status, steps: [], attachments: [], start: start + 1.25, stop: start + 4.75,
      fullName: marker, historyId: hash('logical case ' + index), uuid: hash(id + index), stage: 'finished',
      labels: [{ name: 'suite', value: marker }, { name: 'execution', value: 'unit' }, { name: 'layer', value: layer }] };
  });
  const summaryPath = join(run, 'summary.json');
  const manifestPath = join(directory, 'dgi-manifest.json');
  const names = records.map(record => record.uuid + '-result.json');
  function saveRecord(i) {
    const bytes = Buffer.from(JSON.stringify(records[i]));
    writeFileSync(join(directory, names[i]), bytes);
    manifest.files[names[i]] = hash(bytes);
    writeJson(manifestPath, manifest);
  }
  records.forEach((_, i) => saveRecord(i));
  writeJson(manifestPath, manifest);
  writeJson(summaryPath, summary);
  const reports = join(workspace, 'reports');
  mkdirSync(reports);
  const xml = join(reports, layer === 'backend' ? 'backend-unit.xml' : 'frontend.xml');
  return { id, run, workspace, directory, reports, xml, records, names, manifest, summary, manifestPath, summaryPath, saveRecord,
    adapt: () => cli(['adapt-dgi', '--run-id', id]) };
}

function success(f) {
  const resp = f.adapt();
  assert.equal(resp.exitCode, 0, resp.stderr);
  assert.ok(!resp.stdout.includes(marker));
  const bytes = Buffer.from(resp.stdout);
  verifyManifestV1(Buffer.from(JSON.stringify(createManifestV1(bytes))), bytes);
  return JSON.parse(resp.stdout);
}

function rejected(f) {
  const resp = f.adapt();
  assert.equal(resp.exitCode, 2);
  assert.equal(resp.stdout, undefined);
  assert.match(resp.stderr, /^Invalid DGI evidence:/);
  assert.ok(!resp.stderr.includes(marker) && !resp.stderr.includes(installation));
}

test('backend unit fixture reconciles direct Node JUnit cases and omits diagnostic content', () => {
  const f = fixture('backend', ['passed', 'failed', 'skipped', 'broken']);
  const details = { message: 'assertion_failure: expected/actual values and raw diagnostics withheld by publishing policy',
    trace: 'backend/test/example.mjs:1:2' };
  f.records[1].statusDetails = details;
  f.records[1].steps.push({ name: marker, status: 'failed', attachments: [], steps: [], statusDetails: details });
  f.saveRecord(1);
  writeFileSync(f.xml, '<testsuites><testcase/><testcase><failure message="' + marker + '"><![CDATA[<testcase/>]]></failure></testcase>' +
    '<testcase><skipped/></testcase><testcase><error/></testcase></testsuites>');
  const result = success(f);
  assert.equal(result.executionStatus, 'FAIL');
  assert.equal(result.childExitCode, 1);
  assert.equal(result.collectionState, 'PARTIAL');
  assert.deepEqual(result.counts, { total: 4, passed: 1, failed: 1, broken: 1, skipped: 1, unknown: 0 });
  const { durationsMs } = adaptDgiAllure(f.id);
  for (const record of f.records) {
    const caseId = createCaseId(result.suiteId, record.historyId);
    assert.deepEqual(result.cases.find(c => c.caseId === caseId), { caseId, executionId: f.id + ':' + caseId,
      status: record.status });
    assert.equal(durationsMs.get(f.id + ':' + caseId), 4);
  }
  assert.ok(!JSON.stringify(result).includes(details.trace));
});

test('frontend Vitest suite aggregates agree and local DGI histories get QEP run-scoped executions', () => {
  const a = fixture('frontend'), b = fixture('frontend');
  writeFileSync(a.xml, '<testsuites tests="1" failures="0" errors="0"><testsuite tests="1" skipped="0">' +
    '<testcase><system-err><![CDATA[' + marker + '<failure/>]]></system-err></testcase></testsuite></testsuites>');
  const one = success(a), two = success(b);
  assert.equal(one.sourceCommit, auditedDgiSha);
  assert.equal(one.collectionState, 'COMPLETE');
  assert.equal(one.cases[0].caseId, two.cases[0].caseId);
  assert.notEqual(one.cases[0].executionId, two.cases[0].executionId);
  assert.equal(one.runId, a.id);
  assert.equal(two.runId, b.id);
  assert.deepEqual(success(a), one);
});

test('only a QEP UUID selector is accepted, including when the supplied path is itself a run', () => {
  const f = fixture();
  for (const args of [[], ['--source', f.run], ['--run-id', f.run], ['--run-id', '../' + f.id],
    ['--run-id', 'local'], ['--run-id', f.id, '--output', marker]]) {
    assert.equal(cli(['adapt-dgi', ...args]).exitCode, 2);
  }
  assert.equal(success(f).runId, f.id);
});

test('requires matching Summary v0 identity, approved revision, test phase and outcome', () => {
  for (const patch of [{ runId: randomUUID() }, { suiteId: 'clu-unit' }, { sourceRepository: marker },
    { commitSha: 'c'.repeat(40) }, { phase: 'install' }, { status: 'BLOCKED' }, { failureCategory: 'missing-evidence' },
    { exitCode: 1 }, { exitCode: null }, { startedAt: 'invalid' }, { durationMs: -1 }, { extra: marker }]) {
    const f = fixture();
    writeJson(f.summaryPath, { ...f.summary, ...patch });
    rejected(f);
  }
});

test('rejects malformed, ambiguous or unaudited DGI manifests', () => {
  for (const patch of [{ schemaVersion: '1' }, { commit: 'b'.repeat(40) }, { ciRun: '123' }, { runtime: 'v22.0.0' },
    { environment: 'github-actions' }, { layer: 'frontend' }, { execution: 'all' }, { dataset: 'other' },
    { testExitCode: null }, { testExitCode: 1 }, { files: [] }, { auditedAttachments: 1 }, { omittedAttachments: -1 },
    { extra: marker }, { counts: { passed: 1, cancelled: 0 } }]) {
    const f = fixture();
    writeJson(f.manifestPath, { ...f.manifest, ...patch });
    rejected(f);
  }
  const f = fixture();
  for (const bytes of ['{', Buffer.from([0xff]), JSON.stringify(f.manifest).replace('{', '{"schema\\u0056ersion":1,')]) {
    writeFileSync(f.manifestPath, bytes);
    rejected(f);
  }
});

test('rejects tampered bytes, missing, extra and unapproved declared files, and empty batches', () => {
  for (const change of [
    f => writeFileSync(join(f.directory, f.names[0]), ' ' + JSON.stringify(f.records[0])),
    f => unlinkSync(join(f.directory, f.names[0])),
    f => writeFileSync(join(f.directory, hash('extra') + '-result.json'), '{}'),
    f => { f.manifest.files['../' + marker] = hash('bad'); delete f.manifest.files[f.names[0]]; writeJson(f.manifestPath, f.manifest); },
    f => { writeFileSync(join(f.directory, 'attachment.txt'), marker); f.manifest.files['attachment.txt'] = hash(marker); writeJson(f.manifestPath, f.manifest); },
  ]) { const f = fixture(); change(f); rejected(f); }
  rejected(fixture('backend', []));
});

test('rejects duplicate UUIDs, duplicate histories and records from mixed executions', () => {
  for (const change of [
    f => { f.records[1].uuid = f.records[0].uuid; },
    f => { f.records[1].historyId = f.records[0].historyId; },
    f => { f.records[1].labels[1].value = 'integration'; },
    f => { f.records[1].labels[2].value = 'frontend'; },
    f => { f.records[1].labels.push({ name: 'execution', value: 'unit' }); },
    f => { f.records[1].start = start - 10; },
    f => { mkdirSync(join(f.directory, '..', 'integration')); },
    f => { mkdirSync(join(f.directory, '../..', 'frontend')); },
  ]) { const f = fixture('backend', ['passed', 'passed']); change(f); f.saveRecord(1); rejected(f); }
});

test('rejects invalid status, timing, attachments and unexpected fields at every record level', () => {
  for (const patch of [{ status: 'success' }, { status: 'failure' }, { stop: start }, { start: null }, { stop: undefined },
    { statusDetails: { message: marker, trace: '' } }, { attachments: [{ source: '../' + marker }] },
    { steps: [{}] }, { stage: 'pending' }, { stdout: marker }, { labels: [{ name: 'suite', value: 's', raw: marker }] }]) {
    const f = fixture();
    Object.assign(f.records[0], patch); f.saveRecord(0); rejected(f);
  }
});

test('rejects mismatched status tallies and PASS with unsuccessful individual evidence', () => {
  for (const counts of [{}, { passed: 2 }, { failed: 1 }, { passed: '1' }, { passed: null }]) {
    const f = fixture(); writeJson(f.manifestPath, { ...f.manifest, counts }); rejected(f);
  }
  const f = fixture('backend', ['unknown']);
  writeJson(f.summaryPath, { ...f.summary, status: 'PASS', exitCode: 0, failureCategory: null });
  writeJson(f.manifestPath, { ...f.manifest, testExitCode: 0 });
  rejected(f);
});

test('rejects XML count discrepancies, invalid structure, DTDs and malformed optional XML', () => {
  const f = fixture('frontend');
  for (const xml of ['<testsuites/>', '<testsuites><testcase><failure/></testcase></testsuites>',
    '<testsuites tests="2"><testcase/></testsuites>',
    '<testsuites><testsuite skipped="1"><testcase/></testsuite></testsuites>',
    '<testsuites><testcase status="unknown"/></testsuites>', '<testsuites><testcase></testsuites>', '<testsuites><oops/><testcase/></testsuites>',
    '<!DOCTYPE testsuites><testsuites><testcase/></testsuites>', '<testsuites><testcase/></testsuites><testsuites/>']) {
    writeFileSync(f.xml, xml); rejected(f);
  }
});

test('rejects symlinked components and files, hardlinks, shared run storage and oversized reads', () => {
  for (const select of [f => f.run, f => f.workspace, f => f.directory, f => f.summaryPath, f => f.manifestPath,
    f => join(f.directory, f.names[0]), f => f.reports, f => f.xml]) {
    const f = fixture();
    writeFileSync(f.xml, '<testsuites><testcase/></testsuites>');
    const path = select(f);
    renameSync(path, path + '.original');
    symlinkSync(path + '.original', path);
    rejected(f);
  }
  const f = fixture();
  linkSync(f.summaryPath, join(f.run, 'alias')); rejected(f);
  unlinkSync(join(f.run, 'alias')); chmodSync(f.run, 0o777); rejected(f);
  chmodSync(f.run, 0o700); truncateSync(join(f.directory, f.names[0]), 256 * 1024 + 1); rejected(f);
  const j = fixture();
  writeFileSync(j.xml, ''); truncateSync(j.xml, 4 * 1024 * 1024 + 1); rejected(j);
});

test('reading ignores the raw directory and preserves existing artifacts across retries', () => {
  const f = fixture();
  const sentinel = join(f.run, 'result-v1.json');
  writeFileSync(sentinel, marker);
  symlinkSync(join(f.workspace, marker), join(f.workspace, 'artifacts/.allure-raw'));
  const initial = readFileSync(f.manifestPath);
  success(f); success(f);
  assert.deepEqual(readFileSync(f.manifestPath), initial);
  assert.equal(readFileSync(sentinel, 'utf8'), marker);
});

test('rejects digest-matched malformed result bytes, duplicate members and excessive nesting', () => {
  const f = fixture();
  for (const bytes of [
    Buffer.from([0xff]), Buffer.from('{'),
    Buffer.from(JSON.stringify(f.records[0]).replace('{', '{"status":"unknown",')),
    Buffer.from('['.repeat(1000) + ']'.repeat(1000)),
  ]) {
    writeFileSync(join(f.directory, f.names[0]), bytes);
    f.manifest.files[f.names[0]] = hash(bytes);
    writeJson(f.manifestPath, f.manifest);
    rejected(f);
  }
});

test('preserves unsuccessful summary outcomes and explicit unknown evidence', () => {
  const f = fixture('frontend', ['unknown']);
  const unknown = success(f);
  assert.equal(unknown.counts.unknown, 1);
  assert.equal(unknown.cases[0].status, 'unknown');
  for (const [status, failureCategory] of [['FAIL', 'missing-evidence'], ['CANCELLED', 'cancelled'], ['TIMEOUT', 'timeout']]) {
    const g = fixture();
    writeJson(g.summaryPath, { ...g.summary, status, failureCategory });
    const result = success(g);
    assert.equal(result.executionStatus, status);
    assert.equal(result.collectionState, 'PARTIAL');
    assert.equal(result.counts.passed, 1);
  }
});

test('results commands collect the same normalized records as the audited DGI adapter', () => {
  const f = fixture('frontend');
  const expected = success(f);
  for (const action of ['collect', 'verify', 'collect']) {
    const response = cli(['results', action, '--run-id', f.id]);
    assert.equal(response.exitCode, 0, response.stderr);
    assert.equal(JSON.parse(response.stdout).runId, f.id);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.run, 'results-v1/result-v1.json'))), expected);
});
