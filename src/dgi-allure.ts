import { createHash } from 'node:crypto';
import { checkJUnit } from './dgi-junit.js';
import { check, dgiLimits, InvalidDgiEvidence, resultFilename, dgiWorkspace, type DgiLayer } from './dgi-workspace.js';
import { isRecord } from './metadata.js';
import {
  createCaseId, createExecutionId, deriveCounts, limitsV1, parseResultV1, type CaseStatus, type ResultContractV1,
} from './result-contract-v1.js';
import { parseStrictJson } from './strict-json.js';

import { withRun, type RunStorage } from './run-storage.js';
import { fields, integer, readSummary as readRunSummary } from './run-summary.js';

const statuses: readonly CaseStatus[] = ['passed', 'failed', 'broken', 'skipped', 'unknown'];
const digestPattern = /^[a-f0-9]{64}$/;
const dataset = 'synthetic-only-v1';

export function dgiSummary(run: ReturnType<typeof readRunSummary>) {
  check(run.suiteId !== 'clu-unit', 'suite');
  const layer: DgiLayer = run.suiteId === 'dgi-backend-unit' ? 'backend' : 'frontend';
  return { ...run, layer };
}
type Run = ReturnType<typeof dgiSummary>;

function readManifest(bytes: Buffer, run: Run, inventory: Set<string>) {
  const v = parseStrictJson(bytes, dgiLimits.manifestBytes, 2, limitsV1.cases);
  fields(v, ['schemaVersion', 'commit', 'branch', 'ciRun', 'runtime', 'environment', 'layer', 'execution',
    'dataset', 'testExitCode', 'counts', 'auditedAttachments', 'omittedAttachments', 'files']);
  check(v.schemaVersion === 1 && v.commit === run.commitSha && v.layer === run.layer && v.execution === 'unit' &&
    v.dataset === dataset && v.testExitCode === run.exitCode && v.runtime === run.runtimeVersion &&
    v.environment === 'local' && v.ciRun === 'local' && typeof v.branch === 'string' &&
    /^[a-zA-Z0-9_./-]{1,120}$/.test(v.branch), 'manifest provenance');
  check(v.auditedAttachments === 0 && integer(v.omittedAttachments), 'unit attachment policy');
  fields(v.counts, [], [...statuses]);
  const files = v.files;
  check(isRecord(files) && inventory.size > 0 && Object.keys(files).length === inventory.size, 'manifest inventory');
  const digests = new Map<string, string>();
  for (const [name, digest] of Object.entries(files)) {
    check(inventory.has(name) && resultFilename.test(name) && name.length === 76 &&
      typeof digest === 'string' && digest.length === 64 && digestPattern.test(digest), 'manifest file');
    digests.set(name, digest);
  }
  return { counts: v.counts, digests };
}

function auditedText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1000 && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}

const projection = ['name', 'status', 'steps', 'attachments'];
const timing = ['start', 'stop', 'statusDetails'];

function checkProjection(v: Record<string, unknown>, run: Run): CaseStatus {
  const status = statuses.find(status => status === v.status);
  check(status && auditedText(v.name) && Array.isArray(v.attachments) && !v.attachments.length &&
    Array.isArray(v.steps), 'audited projection');
  for (const time of [v.start, v.stop]) {
    if (time !== undefined) check(typeof time === 'number' && Number.isFinite(time) && time >= run.start && time <= run.stop, 'record time outside run');
  }
  if (typeof v.start === 'number' && typeof v.stop === 'number') check(v.stop >= v.start, 'record interval');
  if (v.statusDetails !== undefined) {
    fields(v.statusDetails, ['message', 'trace']);
    check(typeof v.statusDetails.message === 'string' &&
      /^(assertion_failure|timeout|test_or_setup_failure): expected\/actual values and raw diagnostics withheld by publishing policy$/.test(v.statusDetails.message) &&
      typeof v.statusDetails.trace === 'string' && v.statusDetails.trace.length <= 8192, 'audited failure details');
    const locations = v.statusDetails.trace ? v.statusDetails.trace.split('\n') : [];
    check(locations.length <= 12 && new Set(locations).size === locations.length && locations.every(location =>
      /^(?:backend\/test|frontend\/src|e2e|scripts)\/[a-zA-Z0-9_./-]+\.(?:mjs|tsx?|js):\d+(?::\d+)?$/.test(location)), 'audited trace');
  }
  for (const step of v.steps) {
    fields(step, projection, timing);
    checkProjection(step, run);
  }
  return status;
}

function readCase(bytes: Buffer, name: string, run: Run) {
  const v = parseStrictJson(bytes, dgiLimits.caseBytes, 24, 16);
  fields(v, [...projection, 'start', 'stop', 'uuid', 'fullName', 'historyId', 'labels', 'stage'], ['statusDetails']);
  check(v.uuid === name.slice(0, 64) && typeof v.historyId === 'string' &&
    v.historyId.length === 64 && digestPattern.test(v.historyId), 'case identity');
  check(v.stage === 'finished' && auditedText(v.fullName) && Array.isArray(v.labels) && v.labels.length <= 64, 'case fields');
  const scopes = new Map<string, string>();
  for (const label of v.labels) {
    fields(label, ['name', 'value']);
    check(typeof label.name === 'string' && auditedText(label.value), 'case label');
    if (label.name === 'layer' || label.name === 'execution') {
      check(!scopes.has(label.name), 'duplicate scope');
      scopes.set(label.name, label.value);
    } else check(['parentSuite', 'suite', 'subSuite', 'framework', 'language', 'package'].includes(label.name), 'case label');
  }
  check(scopes.get('layer') === run.layer && scopes.get('execution') === 'unit', 'case scope');
  const status = checkProjection(v, run);
  check(typeof v.start === 'number' && typeof v.stop === 'number', 'case timing');
  const caseId = createCaseId(run.suiteId, v.historyId);
  return { caseId, executionId: createExecutionId(run.runId, caseId), status, durationMs: Math.round(v.stop - v.start) };
}

export function collectDgi(storage: Omit<RunStorage, 'verifyInventory'>, run: Run, summaryBytes: number): {
  result: ResultContractV1;
  durationsMs: ReadonlyMap<string, number>;
} {
  const input = dgiWorkspace(storage, summaryBytes);
  const batch = input.batch(run.layer);
  const manifest = readManifest(batch.manifest, run, batch.inventory);
  const cases = [];
  const durationsMs = new Map<string, number>();
  for (const [name, digest] of manifest.digests) {
    const bytes = batch.readResult(name);
    check(createHash('sha256').update(bytes).digest('hex') === digest, 'file digest');
    const { durationMs, ...record } = readCase(bytes, name, run);
    check(!durationsMs.has(record.executionId), 'duplicate case identity');
    durationsMs.set(record.executionId, durationMs);
    cases.push(record);
  }
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const counts = deriveCounts(cases);
  for (const status of statuses) {
    const declared = Object.hasOwn(manifest.counts, status) ? manifest.counts[status] : 0;
    check(declared === counts[status], 'manifest counts');
  }
  const junit = input.junit(run.layer);
  if (junit) checkJUnit(junit, counts);
  const result = parseResultV1(Buffer.from(JSON.stringify({ schemaVersion: 1, runId: run.runId, suiteId: run.suiteId,
    sourceCommit: run.commitSha, executionStatus: run.status, childExitCode: run.exitCode,
    collectionState: run.status === 'PASS' ? 'COMPLETE' : 'PARTIAL', cases, counts })));
  return { result, durationsMs };
}

export function adaptDgiAllure(runId: string) {
  try {
    return withRun(runId, storage => {
      const summary = storage.file(storage.run, 'summary.json', dgiLimits.summaryBytes);
      const adapted = collectDgi(storage, dgiSummary(readRunSummary(summary, runId)), summary.length);
      storage.verifyInventory();
      return adapted;
    });
  } catch (error) {
    // Filesystem, XML and JSON exceptions may contain paths or raw input.
    if (error instanceof InvalidDgiEvidence) throw error;
    throw new InvalidDgiEvidence('unreadable or malformed run');
  }
}
