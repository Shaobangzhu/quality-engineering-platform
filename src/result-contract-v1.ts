import { createHash } from 'node:crypto';
import type { Outcome } from './run-process.js';
import { parseStrictJson } from './strict-json.js';
import { isRecord } from './metadata.js';
import { findSuite, type SuiteDefinition } from './suite-catalog.js';

type SuiteId = SuiteDefinition['id'];
export type CaseStatus = 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';
type CollectionState = 'COMPLETE' | 'PARTIAL' | 'INVALID';
type Counts = Record<CaseStatus | 'total', number>;
export type CaseRecordV1 = { caseId: string; executionId: string; status: CaseStatus };
type Provenance = { runId: string; suiteId: SuiteId; sourceCommit: string };

export type ResultContractV1 = Provenance & {
  schemaVersion: 1;
  executionStatus: Outcome['status'] | 'UNKNOWN';
  childExitCode?: number | null;
  collectionState: CollectionState;
  cases: CaseRecordV1[];
  counts: Counts;
};

export type ManifestV1 = Provenance & {
  schemaVersion: 1;
  files: [{ name: 'result-v1.json'; bytes: number; sha256: string }];
};

export const limitsV1 = Object.freeze({
  cases: 10_000, resultBytes: 4 * 1024 * 1024, manifestBytes: 1024, logicalKeyBytes: 512,
});

function requireValue(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error('Invalid result contract v1: ' + reason);
}

function digest(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validRunId(id: unknown): asserts id is string {
  requireValue(typeof id === 'string' && id.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), 'runId');
}

function suiteId(value: unknown): SuiteId {
  const suite = typeof value === 'string' && findSuite(value);
  requireValue(suite, 'suiteId');
  return suite.id;
}

// Only the digest of the stable logical key crosses the persistence boundary.
export function createCaseId(suite: SuiteId, logicalKey: string): string {
  suiteId(suite);
  requireValue(typeof logicalKey === 'string' && logicalKey.length > 0 &&
    logicalKey.length <= limitsV1.logicalKeyBytes && Buffer.byteLength(logicalKey) <= limitsV1.logicalKeyBytes &&
    logicalKey.trim() === logicalKey, 'logical key');
  return suite + ':' + digest(JSON.stringify(['qep-case-v1', suite, logicalKey]));
}

function validCaseId(id: unknown): asserts id is string {
  requireValue(typeof id === 'string' && id.length <= 82, 'caseId');
  const parts = id.split(':');
  requireValue(parts.length === 2 && parts[1].length === 64 && /^[0-9a-f]+$/.test(parts[1]), 'caseId');
  suiteId(parts[0]);
}

export function createExecutionId(runId: string, caseId: string): string {
  validRunId(runId);
  validCaseId(caseId);
  return runId + ':' + caseId;
}

// Inputs are semantic outcomes. Framework-specific extraction belongs to callers.
export function mapCaseStatus(outcome: unknown): CaseStatus {
  switch (outcome) {
    case 'passed': case 'failed': case 'broken': case 'skipped': return outcome;
    case 'failure': return 'failed';
    case 'error': return 'broken';
    case 'disabled': return 'skipped';
    default: return 'unknown';
  }
}

export function deriveCounts(cases: readonly CaseRecordV1[]): Counts {
  requireValue(Array.isArray(cases) && cases.length <= limitsV1.cases, 'case limit');
  const counts = { total: cases.length, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
  for (const record of cases) {
    const status = mapCaseStatus(record?.status);
    requireValue(record?.status === status, 'case status');
    counts[status]++;
  }
  return counts;
}

function parse(bytes: Uint8Array, limit: number): unknown {
  try {
    return parseStrictJson(bytes, limit, 4, 10);
  } catch {
    throw new Error('Invalid result contract v1: JSON encoding');
  }
}

function fields(value: unknown, keys: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  requireValue(isRecord(value) && keys.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => keys.includes(key) || optional.includes(key)), 'object fields');
}

const header = ['schemaVersion', 'runId', 'suiteId', 'sourceCommit'];

function provenance(value: Record<string, unknown>): Provenance {
  requireValue(value.schemaVersion === 1, 'schema version');
  validRunId(value.runId);
  requireValue(typeof value.sourceCommit === 'string' && value.sourceCommit.length === 40 &&
    /^[0-9a-f]+$/.test(value.sourceCommit), 'source commit');
  return { runId: value.runId, suiteId: suiteId(value.suiteId), sourceCommit: value.sourceCommit };
}

export function parseResultV1(bytes: Uint8Array): ResultContractV1 {
  const value = parse(bytes, limitsV1.resultBytes);
  fields(value, [...header, 'executionStatus', 'collectionState', 'cases', 'counts'], ['childExitCode']);
  const run = provenance(value);
  const { executionStatus, collectionState, childExitCode } = value;
  requireValue(executionStatus === 'PASS' || executionStatus === 'FAIL' || executionStatus === 'BLOCKED' ||
    executionStatus === 'CANCELLED' || executionStatus === 'TIMEOUT' || executionStatus === 'UNKNOWN', 'execution status');
  requireValue(collectionState === 'COMPLETE' || collectionState === 'PARTIAL' || collectionState === 'INVALID', 'collection state');
  requireValue(childExitCode == null || (typeof childExitCode === 'number' && Number.isInteger(childExitCode) &&
    childExitCode >= 0 && childExitCode <= 255), 'child exit');
  requireValue(Array.isArray(value.cases) && value.cases.length <= limitsV1.cases, 'case limit');
  const seen = new Set<string>();
  const cases = value.cases.map((item: unknown) => {
    fields(item, ['caseId', 'executionId', 'status']);
    requireValue(typeof item.caseId === 'string', 'caseId');
    requireValue(item.caseId.startsWith(run.suiteId + ':') && !seen.has(item.caseId), 'case identity');
    seen.add(item.caseId);
    const executionId = createExecutionId(run.runId, item.caseId);
    requireValue(item.executionId === executionId, 'execution identity');
    const status = mapCaseStatus(item.status);
    requireValue(status === item.status, 'case status');
    return { caseId: item.caseId, executionId, status };
  });
  const counts = deriveCounts(cases);
  fields(value.counts, Object.keys(counts));
  for (const [key, count] of Object.entries(counts)) requireValue(value.counts[key] === count, 'counts');
  requireValue((counts.total === 0) === (collectionState === 'INVALID'), 'collection evidence');
  if (executionStatus === 'PASS') {
    requireValue(childExitCode === 0 && counts.passed > 0 && !counts.failed && !counts.broken && !counts.unknown &&
      collectionState === 'COMPLETE', 'pass evidence');
  }
  if (collectionState === 'COMPLETE') requireValue(executionStatus === 'PASS', 'complete execution');
  return { schemaVersion: 1, ...run, executionStatus, collectionState, cases, counts,
    ...(childExitCode === undefined ? {} : { childExitCode }) };
}

export function createManifestV1(resultBytes: Uint8Array): ManifestV1 {
  const { runId, suiteId, sourceCommit } = parseResultV1(resultBytes);
  return { schemaVersion: 1, runId, suiteId, sourceCommit,
    files: [{ name: 'result-v1.json', bytes: resultBytes.byteLength, sha256: digest(resultBytes) }] };
}

export function verifyManifestV1(manifestBytes: Uint8Array, resultBytes: Uint8Array): ManifestV1 {
  const value = parse(manifestBytes, limitsV1.manifestBytes);
  fields(value, [...header, 'files']);
  const run = provenance(value);
  requireValue(Array.isArray(value.files) && value.files.length === 1, 'manifest inventory');
  const file: unknown = value.files[0];
  fields(file, ['name', 'bytes', 'sha256']);
  const expected = createManifestV1(resultBytes);
  requireValue(run.runId === expected.runId && run.suiteId === expected.suiteId &&
    run.sourceCommit === expected.sourceCommit, 'manifest provenance');
  const [entry] = expected.files;
  requireValue(file.name === entry.name && file.bytes === entry.bytes && file.sha256 === entry.sha256, 'manifest integrity');
  return expected;
}
