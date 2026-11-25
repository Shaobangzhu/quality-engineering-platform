import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditedCluSha } from '../dist/suite-catalog.js';
import { createManifestV1, verifyManifestV1 } from '../dist/result-contract-v1.js';

let root, runs, cli, adapt, withRun, readSummary;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'qep-clu-results-'));
  cpSync(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  cpSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'));
  runs = join(root, '.local/runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const module = name => import(pathToFileURL(join(root, 'dist', name + '.js')));
  ({ runCli: cli } = await module('run-cli'));
  ({ adaptCluJUnit: adapt } = await module('clu-junit'));
  ({ withRun } = await module('run-storage'));
  ({ readSummary } = await module('run-summary'));
});
after(() => rmSync(root, { recursive: true }));

const basic = '<testsuites tests="1"><testsuite name="unit" tests="1"><testcase classname="file" name="case" time="0.004"/></testsuite></testsuites>';
function fixture(xml = basic, patch = {}) {
  const id = randomUUID(), run = join(runs, id), dir = join(run, 'workspace/artifacts/qep');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'unit.xml');
  const summary = Buffer.from(JSON.stringify({ runId: id, suiteId: 'clu-unit', sourceRepository: '@shaobangzhu/clu-ui',
    commitSha: auditedCluSha, runtimeVersion: process.version, startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000, phase: 'test', status: 'PASS', exitCode: 0,
    failureCategory: null, ...patch }));
  writeFileSync(join(run, 'summary.json'), summary);
  writeFileSync(path, xml);
  const digest = value => createHash('sha256').update(value).digest('hex');
  writeFileSync(join(run, 'clu-junit.receipt'), JSON.stringify([digest(summary), digest(xml)]) + '\n');
  const output = join(run, 'results-v1');
  return { id, run, path, summary, output, result: join(output, 'result-v1.json'), manifest: join(output, 'manifest-v1.json'),
    invoke: action => cli(['results', action, '--run-id', id]) };
}

function rejected(response) {
  assert.equal(response.exitCode, 2);
  assert.equal(response.stdout, undefined);
  assert.ok(!response.stderr.includes(root) && !response.stderr.includes('DIAGNOSTIC'));
}

test('collect and verify publish a deterministic pair and preserve history on retry', () => {
  const f = fixture();
  rejected(f.invoke('verify'));
  const response = f.invoke('collect');
  assert.equal(response.exitCode, 0, response.stderr);
  const bytes = readFileSync(f.result);
  assert.deepEqual(JSON.parse(response.stdout), verifyManifestV1(readFileSync(f.manifest), bytes));
  const result = JSON.parse(bytes);
  assert.equal(result.counts.passed, 1);
  assert.equal(result.executionStatus, 'PASS');
  const timings = withRun(f.id, storage => adapt(storage, f.summary, readSummary(f.summary, f.id))).durationsMs;
  assert.equal(timings.get(result.cases[0].executionId), 4);
  const before = statSync(f.result, { bigint: true });
  for (const action of ['collect', 'verify']) assert.deepEqual(f.invoke(action), response);
  assert.deepEqual(statSync(f.result, { bigint: true }).ctimeNs, before.ctimeNs);
  const other = fixture();
  assert.equal(other.invoke('collect').exitCode, 0);
  const [record] = JSON.parse(readFileSync(other.result)).cases;
  assert.equal(record.caseId, result.cases[0].caseId);
  assert.notEqual(record.executionId, result.cases[0].executionId);
});

const fail = { status: 'FAIL', exitCode: 1, failureCategory: 'exit-nonzero' };
test('nested totals reconcile failure, error and skip without retaining diagnostics', () => {
  const xml = '<testsuites tests="3" errors="1" failures="1"><testsuite tests="3"><testsuite tests="2" failures="1">' +
    '<testcase name="one"><failure message="DIAGNOSTIC">stack</failure><failure>second</failure></testcase>' +
    '<testcase name="two"><skipped/><system-out><![CDATA[<failure/>]]></system-out></testcase></testsuite>' +
    '<testcase name="three"><error>DIAGNOSTIC</error><system-err>raw</system-err></testcase></testsuite></testsuites>';
  const f = fixture(xml, fail);
  assert.equal(f.invoke('collect').exitCode, 0);
  const bytes = readFileSync(f.result, 'utf8');
  assert.doesNotMatch(bytes, /DIAGNOSTIC|stack|three|system-err/);
  const result = JSON.parse(bytes);
  assert.equal(result.collectionState, 'PARTIAL');
  assert.deepEqual(result.counts, { total: 3, passed: 0, failed: 1, broken: 1, skipped: 1, unknown: 0 });
  rejected(fixture(xml).invoke('collect'));
  const empty = fixture('<testsuite tests="0"/>', fail);
  assert.equal(empty.invoke('collect').exitCode, 0);
  assert.equal(JSON.parse(readFileSync(empty.result)).collectionState, 'INVALID');
});

test('rejects malformed, contradictory, unbounded or entity-bearing JUnit', () => {
  for (const xml of ['<testsuite tests="0"/>', '<testsuite>', basic.replace('tests="1"', 'tests="2"'),
    basic.replace('tests="1"><testcase', 'tests="0"><testcase'), basic.replace('name="case"', 'status="unknown"'),
    basic.replace('/></testsuite>', '><failure/><error/></testcase></testsuite>'),
    basic.replace('time="0.004"/>', '/><testcase name="case" classname="file"/>').replaceAll('tests="1"', 'tests="2"'),
    basic.replace('0.004', 'Infinity'), basic.replace('name="case"', 'name="&custom;"'),
    '<!DOCTYPE testsuites SYSTEM "file:///DIAGNOSTIC">' + basic,
    '<!DOCTYPE testsuites [<!ENTITY custom "DIAGNOSTIC">]>' + basic, Buffer.from([0xff]),
    '<testsuite tests="1">'.repeat(17) + '<testcase name="c"/>' + '</testsuite>'.repeat(17)]) {
    const f = fixture(xml);
    rejected(f.invoke('collect'));
    assert.ok(!existsSync(f.output));
  }
  const huge = fixture();
  truncateSync(huge.path, 4 * 1024 * 1024 + 1);
  rejected(huge.invoke('collect'));
});

test('rejects invalid Summary v0, swapped report bytes, missing evidence and path selectors', () => {
  for (const patch of [{ runId: randomUUID() }, { sourceRepository: 'wrong' }, { commitSha: '1'.repeat(40) },
    { suiteId: 'dgi-backend-unit' }, { exitCode: 1 }, { phase: 'install' }, { durationMs: -1 }, { extra: 1 }]) {
    rejected(fixture(basic, patch).invoke('collect'));
  }
  const f = fixture();
  writeFileSync(f.path, basic.replace('name="case"', 'name="other"'));
  rejected(f.invoke('collect'));
  unlinkSync(f.path);
  rejected(f.invoke('collect'));
  for (const args of [['--run-id', '../' + f.id], ['--run-id', f.run], ['--run-id', f.id, '--out', root]]) {
    rejected(cli(['results', 'collect', ...args]));
  }
});

test('refuses symlinked path components, hardlinks, and conflicting historical outputs', () => {
  for (const relative of ['', 'workspace', 'workspace/artifacts', 'workspace/artifacts/qep', 'workspace/artifacts/qep/unit.xml',
    'summary.json', 'clu-junit.receipt', 'results-v1', 'results-v1/result-v1.json', 'results-v1/manifest-v1.json']) {
    const f = fixture();
    if (relative.startsWith('results-v1')) assert.equal(f.invoke('collect').exitCode, 0);
    const path = join(f.run, relative);
    renameSync(path, path + '.original');
    symlinkSync(path + '.original', path);
    rejected(f.invoke('collect'));
  }
  const f = fixture();
  linkSync(f.path, join(f.run, 'alias'));
  rejected(f.invoke('collect'));
  for (const relative of ['result-v1.json', 'results-v1/manifest-v1.json', 'results-v1/result-v1.json']) {
    const g = fixture();
    if (relative.includes('/')) mkdirSync(g.output);
    writeFileSync(join(g.run, relative), 'historical');
    rejected(g.invoke('collect'));
    assert.equal(readFileSync(join(g.run, relative), 'utf8'), 'historical');
  }
});

test('rejects hash tampering, alternate valid serialization and mixed execution pairs', () => {
  for (const change of [f => writeFileSync(f.result, readFileSync(f.result, 'utf8') + ' '),
    f => writeFileSync(f.manifest, readFileSync(f.manifest, 'utf8') + ' '),
    f => {
      const bytes = Buffer.from(readFileSync(f.result, 'utf8') + ' ');
      writeFileSync(f.result, bytes);
      writeFileSync(f.manifest, JSON.stringify(createManifestV1(bytes)) + '\n');
    }, f => {
      const other = fixture();
      assert.equal(other.invoke('collect').exitCode, 0);
      cpSync(other.result, f.result);
      cpSync(other.manifest, f.manifest);
    }]) {
    const f = fixture();
    assert.equal(f.invoke('collect').exitCode, 0);
    change(f);
    const before = readFileSync(f.result);
    rejected(f.invoke('verify'));
    rejected(f.invoke('collect'));
    assert.deepEqual(readFileSync(f.result), before);
  }
});
