import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createCaseId, createExecutionId, createManifestV1, deriveCounts, limitsV1,
  mapCaseStatus, parseResultV1, verifyManifestV1,
} from '../dist/result-contract-v1.js';

const suite = 'clu-unit';
const run = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const otherRun = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
const encode = value => Buffer.from(JSON.stringify(value));

function fixture(statuses = ['passed']) {
  const cases = statuses.map((status, i) => {
    const caseId = createCaseId(suite, 'unit/example#' + i);
    return { caseId, executionId: createExecutionId(run, caseId), status };
  });
  return { schemaVersion: 1, suiteId: suite, runId: run, sourceCommit: 'a'.repeat(40),
    executionStatus: 'PASS', collectionState: 'COMPLETE', childExitCode: 0, cases, counts: deriveCounts(cases) };
}

test('single-run fixture validates and manifest commits to exact UTF-8 bytes', () => {
  const value = fixture();
  const bytes = encode(value);
  assert.deepEqual(parseResultV1(bytes), value);
  const manifest = createManifestV1(bytes);
  assert.deepEqual(manifest.files, [{ name: 'result-v1.json', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }]);
  assert.deepEqual(verifyManifestV1(encode(manifest), bytes), manifest);
  assert.throws(() => verifyManifestV1(encode(manifest), Buffer.concat([bytes, Buffer.from('\n')])));
});

test('case IDs are stable across revisions and runs and scoped to suites', () => {
  const original = fixture();
  const next = { ...fixture(), runId: otherRun, sourceCommit: 'b'.repeat(40) };
  for (const c of next.cases) c.executionId = createExecutionId(otherRun, c.caseId);
  const [a, b] = [original, next].map(v => parseResultV1(encode(v)).cases[0]);
  assert.equal(a.caseId, 'clu-unit:2755f53e016f1458abb2071a52518b3488d2a2d1cf1783a64c6bf6689e1f6105');
  assert.equal(a.caseId, b.caseId);
  assert.notEqual(a.executionId, b.executionId);
  assert.ok(b.executionId.startsWith(otherRun + ':'));
  assert.notEqual(a.caseId, createCaseId('dgi-backend-unit', 'unit/example#0'));
  assert.notEqual(a.caseId, createCaseId(suite, 'unit/example#1'));
  for (const id of ['dgi-frontend-unit', 'dgi-backend-unit']) {
    const caseId = createCaseId(id, 'unit/example#0');
    const result = { ...original, suiteId: id, cases: [{ caseId, executionId: createExecutionId(run, caseId), status: 'passed' }] };
    assert.deepEqual(parseResultV1(encode(result)), result);
  }
});

test('semantic mapping and counts for mixed partial evidence', () => {
  const statuses = ['passed', 'failure', 'error', 'disabled', 'unrecognized'].map(mapCaseStatus);
  assert.deepEqual(statuses, ['passed', 'failed', 'broken', 'skipped', 'unknown']);
  const value = { ...fixture(statuses), executionStatus: 'FAIL', collectionState: 'PARTIAL', childExitCode: 1 };
  assert.deepEqual(parseResultV1(encode(value)).counts,
    { total: 5, passed: 1, failed: 1, broken: 1, skipped: 1, unknown: 1 });
  assert.equal(mapCaseStatus(0), 'unknown');
});

test('missing or null child exit is preserved for unavailable evidence', () => {
  const v = { ...fixture([]), executionStatus: 'BLOCKED', collectionState: 'INVALID', childExitCode: null };
  assert.deepEqual(parseResultV1(encode(v)), v);
  delete v.childExitCode;
  assert.deepEqual(parseResultV1(encode(v)), v);
});

test('rejects missing and invalid fields throughout the result', () => {
  for (const change of [
    v => { delete v.sourceCommit; }, v => { delete v.cases[0].caseId; }, v => { delete v.counts.total; },
    v => { v.schemaVersion = 2; }, v => { v.runId = 'bad'; }, v => { v.suiteId = 'unknown'; },
    v => { v.sourceCommit = 'abc'; }, v => { v.cases[0].status = 'failure'; }, v => { v.cases = {}; },
    v => { v.counts.passed = 0; }, v => { v.counts.extra = 1; }, v => { v.childExitCode = -1; },
  ]) {
    const v = fixture();
    change(v);
    assert.throws(() => parseResultV1(encode(v)));
  }
});

test('rejects duplicate or mixed identities and nested provenance overrides', () => {
  for (const change of [
    v => { v.cases[1] = v.cases[0]; }, v => { v.cases[1].executionId = v.cases[0].executionId; },
    v => { v.runId = otherRun; }, v => { v.suiteId = 'dgi-frontend-unit'; },
    v => { v.cases[0].sourceCommit = 'b'.repeat(40); },
  ]) {
    const v = fixture(['passed', 'passed']);
    change(v);
    assert.throws(() => parseResultV1(encode(v)));
  }
});

test('complete requires positive case evidence and successful execution', () => {
  for (const status of ['FAIL', 'BLOCKED', 'TIMEOUT', 'CANCELLED']) {
    assert.throws(() => parseResultV1(encode({ ...fixture(), executionStatus: status })));
  }
  for (const statuses of [[], ['unknown'], ['skipped'], ['passed', 'failed'], ['passed', 'broken']]) {
    assert.throws(() => parseResultV1(encode(fixture(statuses))));
  }
  for (const exit of [1, null, undefined]) {
    assert.throws(() => parseResultV1(encode({ ...fixture(), childExitCode: exit })));
  }
});

test('manifest rejects SHA mismatch, foreign provenance, paths and extra files', () => {
  const bytes = encode(fixture());
  for (const change of [
    m => { m.files[0].sha256 = '0'.repeat(64); }, m => { m.files[0].bytes++; },
    m => { m.runId = otherRun; }, m => { m.suiteId = 'dgi-backend-unit'; },
    m => { m.sourceCommit = 'b'.repeat(40); }, m => { m.files[0].name = '/etc/passwd'; },
    m => { m.files.push(m.files[0]); }, m => { m.files[0].extra = ''; },
  ]) {
    const manifest = createManifestV1(bytes);
    change(manifest);
    assert.throws(() => verifyManifestV1(encode(manifest), bytes));
  }
});

test('sensitive fields and ambiguous JSON are rejected without echoing input', () => {
  const marker = 'Bearer synthetic-secret';
  for (const field of ['stdout', 'stderr', 'actual', 'expected', 'stack', 'credentials', 'path']) {
    const v = fixture();
    v.cases[0][field] = marker;
    assert.throws(() => parseResultV1(encode(v)), e => !e.message.includes(marker));
  }
  assert.ok(!createCaseId(suite, marker).includes(marker));
  const duplicate = encode(fixture()).toString().replace('"passed"}', '"'+marker+'","status":"passed"}');
  assert.throws(() => createManifestV1(Buffer.from(duplicate)));
  assert.throws(() => parseResultV1(Buffer.from([0xff])));
});

test('enforces file, array, count and logical identity limits', () => {
  assert.throws(() => createCaseId(suite, 'é'.repeat(limitsV1.logicalKeyBytes)));
  const v = fixture();
  assert.throws(() => parseResultV1(Buffer.alloc(limitsV1.resultBytes + 1, 32)));
  assert.throws(() => verifyManifestV1(Buffer.alloc(limitsV1.manifestBytes + 1, 32), encode(v)));
  assert.throws(() => parseResultV1(encode({ ...v, cases: Array(limitsV1.cases + 1).fill(null) })));
  assert.throws(() => parseResultV1(encode({ ...v, counts: { ...v.counts, total: 1e20 } })));
});
