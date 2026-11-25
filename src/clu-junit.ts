import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseJUnit } from './junit.js';
import { createCaseId, createExecutionId, parseResultV1, type CaseRecordV1 } from './result-contract-v1.js';
import { entries, fdPath, withRun, type RunStorage } from './run-storage.js';
import { readSummary } from './run-summary.js';
import { auditedCluSha } from './suite-catalog.js';

function junit({ run, child, file }: RunStorage) {
  const workspace = child(run, 'workspace');
  const directory = child(child(workspace, 'artifacts', true), 'qep', true);
  if (!entries(directory, 1).has('unit.xml')) throw new Error('Missing CLU report.');
  return file(directory, 'unit.xml', 4 * 1024 * 1024);
}

// The reporter has no run identifier. Bind its exact bytes to the runner's
// exact summary at child completion, before summary.json becomes visible.
function receipt(summary: Buffer, xml: Buffer) {
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return Buffer.from(JSON.stringify([hash(summary), hash(xml)]) + '\n');
}

export function sealCluReport(runId: string, summary: Buffer) {
  withRun(runId, storage => {
    const bytes = receipt(summary, junit(storage));
    storage.verifyInventory();
    writeFileSync(fdPath(storage.run) + '/clu-junit.receipt', bytes, { flag: 'wx', mode: 0o600 });
  });
}

export function adaptCluJUnit(storage: RunStorage, summary: Buffer, run: ReturnType<typeof readSummary>) {
  const xml = junit(storage);
  if (run.suiteId !== 'clu-unit' || !receipt(summary, xml).equals(storage.file(storage.run, 'clu-junit.receipt', 256))) {
    throw new Error('CLU report provenance mismatch.');
  }
  const cases: CaseRecordV1[] = [];
  const durationsMs = new Map<string, number>();
  const counts = parseJUnit(xml, (attrs, status, suiteNames) => {
    if (!attrs.name?.trim()) throw new Error('Missing case identity.');
    const parts = [...suiteNames, attrs.classname ?? '', attrs.name];
    if (parts.some(part => part.length > 512)) throw new Error('Oversized case identity.');
    const caseId = createCaseId('clu-unit', JSON.stringify(parts));
    const executionId = createExecutionId(run.runId, caseId);
    if (attrs.time !== undefined) {
      const ms = Math.round(Number(attrs.time) * 1000);
      if (!/^\d+(?:\.\d+)?$/.test(attrs.time) || !Number.isSafeInteger(ms)) throw new Error('Invalid case duration.');
      durationsMs.set(executionId, ms);
    }
    cases.push({ caseId, executionId, status });
  });
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const result = parseResultV1(Buffer.from(JSON.stringify({ schemaVersion: 1, runId: run.runId, suiteId: run.suiteId,
    sourceCommit: auditedCluSha, executionStatus: run.status, childExitCode: run.exitCode,
    collectionState: counts.total === 0 ? 'INVALID' : run.status === 'PASS' ? 'COMPLETE' : 'PARTIAL', cases, counts })));
  return { result, durationsMs };
}
