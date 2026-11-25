import { parseStrictJson } from './strict-json.js';
import { isRecord } from './metadata.js';
import { auditedCluSha, auditedDgiSha, findSuite } from './suite-catalog.js';

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error('Invalid run evidence: ' + reason);
}

export function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  check(isRecord(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'schema fields');
}

export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function instant(value: unknown) {
  check(typeof value === 'string' && value.length === 24, 'summary timestamp');
  const ms = Date.parse(value);
  check(integer(ms) && new Date(ms).toISOString() === value, 'summary timestamp');
  return ms;
}

export function readSummary(bytes: Buffer, runId: string) {
  const v = parseStrictJson(bytes, 4096, 1, 12);
  fields(v, ['runId', 'suiteId', 'sourceRepository', 'commitSha', 'runtimeVersion', 'startedAt', 'endedAt',
    'durationMs', 'phase', 'status', 'exitCode', 'failureCategory']);
  const { suiteId, runtimeVersion, exitCode, status, failureCategory } = v;
  check(suiteId === 'clu-unit' || suiteId === 'dgi-backend-unit' || suiteId === 'dgi-frontend-unit', 'suite');
  const suite = findSuite(suiteId);
  check(suite, 'suite catalog');
  const sourceRepository = suite.repository;
  const commitSha = suiteId === 'clu-unit' ? auditedCluSha : auditedDgiSha;
  check(v.runId === runId && v.sourceRepository === sourceRepository &&
    v.commitSha === commitSha && v.phase === 'test', 'summary provenance');
  const start = instant(v.startedAt), stop = instant(v.endedAt);
  check(start <= stop && integer(v.durationMs) && typeof runtimeVersion === 'string' &&
    /^v\d+\.\d+\.\d+$/.test(runtimeVersion), 'summary runtime');
  check((integer(exitCode) && exitCode <= 255) || (suiteId === 'clu-unit' && exitCode === null), 'child exit');
  check((status === 'PASS' && exitCode === 0 && failureCategory === null) ||
    (status === 'FAIL' && ((failureCategory === 'exit-nonzero' && exitCode !== null && exitCode !== 0) ||
      (exitCode === 0 && (failureCategory === 'failed-evidence' || failureCategory === 'missing-evidence')) ||
      failureCategory === 'background-process' || (failureCategory === 'signal' && exitCode === null))) ||
    (status === 'CANCELLED' && failureCategory === 'cancelled') ||
    (status === 'TIMEOUT' && failureCategory === 'timeout'), 'summary outcome');
  return { suiteId, runId, sourceRepository, commitSha, runtimeVersion, start, stop, exitCode, status, failureCategory } as const;
}
