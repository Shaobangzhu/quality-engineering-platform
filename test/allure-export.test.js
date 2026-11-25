import assert from 'node:assert/strict';
import test from 'node:test';
import { allureExportLimits, exportAllureResults } from '../dist/allure-export.js';
import { createCaseId, createExecutionId, deriveCounts, parseResultV1 } from '../dist/result-contract-v1.js';

const runId = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const sourceCommit = 'a'.repeat(40);
const validated = value => parseResultV1(Buffer.from(JSON.stringify(value)));
const readResult = file => JSON.parse(file.bytes);

function fixture(statuses = ['passed'], options = {}) {
  const { suiteId = 'clu-unit', run = runId, commit = sourceCommit, key = 'unit/example' } = options;
  const cases = statuses.map((status, index) => {
    const caseId = createCaseId(suiteId, `${key}#${index}`);
    return { caseId, executionId: createExecutionId(run, caseId), status };
  });
  const complete = statuses.includes('passed') && statuses.every(s => s === 'passed' || s === 'skipped');
  return { schemaVersion: 1, runId: run, suiteId, sourceCommit: commit, cases, counts: deriveCounts(cases),
    executionStatus: complete ? 'PASS' : 'FAIL', childExitCode: complete ? 0 : 1,
    collectionState: complete ? 'COMPLETE' : cases.length ? 'PARTIAL' : 'INVALID' };
}

test('exports one valid case with only the minimal Allure fields and approved labels', () => {
  const contract = validated(fixture());
  const uuid = 'f4f39542-f884-8de5-be1d-9dcee21619b6';
  const expected = {
    uuid, testCaseId: contract.cases[0].caseId, name: 'Case 2755f53e016f', status: 'passed',
    labels: [{ name: 'suite', value: 'clu-unit' }, { name: 'qep.repository', value: '@shaobangzhu/clu-ui' }],
  };
  assert.deepEqual(exportAllureResults(contract), [
    { name: uuid + '-result.json', bytes: Buffer.from(JSON.stringify(expected) + '\n') },
  ]);
  for (const suiteId of ['dgi-backend-unit', 'dgi-frontend-unit']) {
    assert.deepEqual(readResult(exportAllureResults(validated(fixture(['passed'], { suiteId })))[0]).labels,
      [{ name: 'suite', value: suiteId }, { name: 'qep.repository', value: 'delivery-geo-intelligence' }]);
  }
});

test('preserves all five case statuses and exact counts in partial evidence', () => {
  const contract = validated(fixture(['passed', 'failed', 'broken', 'skipped', 'unknown', 'failed']));
  const files = exportAllureResults(contract);
  const expected = new Map(contract.cases.map(c => [c.caseId, c.status]));
  const counts = { total: files.length, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
  const uuids = new Set();
  for (const file of files) {
    const { uuid, testCaseId, status } = readResult(file);
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(file.name, uuid + '-result.json');
    assert.equal(status, expected.get(testCaseId));
    expected.delete(testCaseId);
    uuids.add(uuid);
    counts[status]++;
  }
  assert.equal(expected.size, 0);
  assert.equal(uuids.size, files.length);
  assert.deepEqual(counts, contract.counts);
  assert.deepEqual(exportAllureResults(validated(fixture([]))), []);
});

test('keeps logical identity across new runs and commits and changes the execution UUID', () => {
  const options = { run: 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb', commit: 'b'.repeat(40) };
  const [first] = exportAllureResults(validated(fixture()));
  const [next] = exportAllureResults(validated(fixture(['passed'], options)));
  assert.equal(readResult(first).testCaseId, readResult(next).testCaseId);
  assert.equal(readResult(first).name, readResult(next).name);
  assert.notEqual(first.name, next.name);
  assert.deepEqual(exportAllureResults(validated(fixture(['passed'], { commit: options.commit }))), [first]);
});

test('rejects duplicate logical cases and execution identities', () => {
  const duplicateCase = validated(fixture(['passed', 'passed']));
  duplicateCase.cases[1] = { ...duplicateCase.cases[0] };
  assert.throws(() => exportAllureResults(duplicateCase), /case identity/);

  const duplicateExecution = validated(fixture(['passed', 'passed']));
  duplicateExecution.cases[1].executionId = duplicateExecution.cases[0].executionId;
  assert.throws(() => exportAllureResults(duplicateExecution), /execution identity/);
});

test('rejects malformed contracts and contradictory counts', () => {
  for (const value of [null, 'result-v1.json', Buffer.from('{}'), { schemaVersion: 1 }]) {
    assert.throws(() => exportAllureResults(value), /Invalid result contract v1/);
  }
  for (const change of [
    v => { v.schemaVersion = 2; }, v => { v.suiteId = '../../synthetic'; },
    v => { v.sourceCommit = 'not-a-commit'; }, v => { v.cases[0].status = 'failure'; },
    v => { delete v.cases[0]; }, v => { v.executionStatus = 'FAIL'; },
  ]) {
    const contract = validated(fixture());
    change(contract);
    assert.throws(() => exportAllureResults(contract), /Invalid result contract v1/);
  }
  for (const change of [
    v => { v.counts.total++; }, v => { v.counts.passed--; v.counts.skipped++; },
    v => { v.counts.unknown = 1; },
  ]) {
    const contract = validated(fixture());
    change(contract);
    assert.throws(() => exportAllureResults(contract), /counts/);
  }
});

test('omits diagnostic data, raw identifiers, and fabricated execution details', () => {
  const marker = 'synthetic-name /home/fixture/test.xml Bearer synthetic-token';
  const contract = validated(fixture(['failed'], { key: marker }));
  const [file] = exportAllureResults(contract);
  const json = readResult(file);
  for (const field of ['start', 'stop', 'duration', 'stage', 'steps', 'attachments', 'fullName', 'statusDetails']) {
    assert.ok(!Object.hasOwn(json, field), field);
  }
  for (const text of [marker, runId, sourceCommit, contract.cases[0].executionId]) {
    assert.ok(!file.name.includes(text));
    assert.ok(!file.bytes.includes(text));
  }
  for (const field of ['stdout', 'stderr', 'stack', 'failure', 'path', 'credentials', 'xml', 'attachments', 'name']) {
    const contaminated = validated(fixture(['failed']));
    contaminated.cases[0][field] = marker;
    assert.throws(() => exportAllureResults(contaminated), error =>
      error.message.startsWith('Invalid result contract v1') && !error.message.includes(marker));
  }
});

test('rejects JavaScript hooks before serialization can execute them', () => {
  let calls = 0;
  const hook = () => { calls++; return fixture(); };
  const contract = validated(fixture());
  assert.throws(() => exportAllureResults({ ...contract, toJSON: hook }), /expected plain data/);
  assert.throws(() => exportAllureResults(new Proxy(contract, { get: hook, ownKeys: hook })), /expected plain data/);
  const record = contract.cases[0];
  Object.defineProperty(record, 'status', { get: hook });
  assert.throws(() => exportAllureResults(contract), /expected plain data/);
  assert.equal(calls, 0);
});

test('sorts by filename and emits identical bytes regardless of input order', () => {
  const contract = validated(fixture(['passed', 'skipped', 'passed']));
  const before = structuredClone(contract);
  const files = exportAllureResults(contract);
  assert.deepEqual(contract, before);
  assert.deepEqual(files, exportAllureResults(contract));
  const { cases, ...header } = contract;
  assert.deepEqual(files, exportAllureResults({ ...header, cases: [...cases].reverse() }));
  assert.deepEqual(files.map(f => f.name), files.map(f => f.name).sort());
});

test('enforces the file count and aggregate byte ceilings', () => {
  const tooMany = { ...fixture(), cases: new Array(allureExportLimits.files + 1) };
  assert.throws(() => exportAllureResults(tooMany), /file count limit/);

  const [sample] = exportAllureResults(validated(fixture()));
  const fits = Math.floor(allureExportLimits.totalBytes / sample.bytes.length);
  assert.ok(fits + 1 <= allureExportLimits.files);
  const files = exportAllureResults(validated(fixture(new Array(fits).fill('passed'))));
  assert.equal(files.length, fits);
  assert.ok(files.every(file => file.bytes.length <= allureExportLimits.fileBytes));
  assert.equal(files.reduce((sum, file) => sum + file.bytes.length, 0), fits * sample.bytes.length);
  const oversized = validated(fixture(new Array(fits + 1).fill('passed')));
  assert.throws(() => exportAllureResults(oversized), /aggregate size limit/);
});
