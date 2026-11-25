import { spawnSync } from 'node:child_process';
import { fstatSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { allureHistoryName, allureReportName } from './allure-generator.js';
import { isRecord } from './metadata.js';
import { limitsV1, sha256, validRunId } from './result-contract-v1.js';
import { entries, fdPath, type LocalStorage } from './run-storage.js';
import { fields, integer } from './run-summary.js';
import { parseStrictJson } from './strict-json.js';
import { findSuite } from './suite-catalog.js';

export const reportManifestName = 'report-manifest.json';
const manifestByteLimit = 1024 * 1024;
const entryByteLimit = 8 * 1024 * 1024;
const historyByteLimit = 32 * 1024 * 1024;
const launchLimit = 512;
const digest = /^[a-f0-9]{64}$/;
const md5 = /^[a-f0-9]{32}$/;
const retryIdentity = /^[a-f0-9]{32}\.[a-f0-9]{32}$/;

export class ReportHistoryError extends Error {}

export type HistoryReceipt = { acceptedLaunches: number; previousReportId: string | null };
type HistoryResult = {
  id: string;
  name: string;
  environment: 'default';
  status: 'passed' | 'skipped';
  labels: { name: string; value: string }[];
  retries: [];
  flaky: false;
  transition?: 'new' | 'fixed';
  retryHash: string;
  url: '';
  reportLinks: [];
};

export type HistoryPoint = {
  uuid: string;
  name: typeof allureReportName;
  timestamp: number;
  knownTestCaseIds: string[];
  testResults: Record<string, HistoryResult>;
  metrics: Record<string, never>;
  url: '';
};

type HistoryEntry = { reportId: string; receipt: HistoryReceipt; point: HistoryPoint; bytes: Buffer };

export function lockReportHistory(reports: number) {
  // flock locks the inherited open file description. The parent holds it
  // until withLocalStorage closes the descriptor, including on process death.
  const result = spawnSync('/usr/bin/flock', ['-n', '-E', '75', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', reports], timeout: 5_000, killSignal: 'SIGKILL',
  });
  if (result.status === 75) throw new ReportHistoryError('Another report history writer is active.');
  if (result.status !== 0) throw new ReportHistoryError('Unable to lock report history.');
}

export function reportManifest(storage: LocalStorage, directory: number) {
  return storage.file(directory, reportManifestName, manifestByteLimit);
}

export function parseReportManifest(bytes: Buffer, reportId: string) {
  const manifest = parseStrictJson(bytes, manifestByteLimit, 12, 100);
  if (!isRecord(manifest) || manifest.reportId !== reportId ||
      (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2)) {
    throw new ReportHistoryError('Invalid report manifest identity or version.');
  }
  return manifest;
}

export function fileDigest(name: string, bytes: Buffer) {
  return { name, bytes: bytes.length, sha256: sha256(bytes) };
}

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid Allure history data.');
}

function emptyArray(value: unknown) {
  return Array.isArray(value) && value.length === 0;
}

function readPoint(bytes: Buffer): HistoryPoint {
  check(bytes.indexOf(0x0a) === bytes.length - 1);
  const point = parseStrictJson(bytes, entryByteLimit, 10, limitsV1.cases);
  fields(point, ['uuid', 'name', 'timestamp', 'knownTestCaseIds', 'testResults', 'metrics', 'url']);
  validRunId(point.uuid);
  check(point.name === allureReportName && integer(point.timestamp) && point.timestamp > 0 && point.url === '' &&
    isRecord(point.metrics) && Object.keys(point.metrics).length === 0);
  const { knownTestCaseIds, testResults } = point;
  check(Array.isArray(knownTestCaseIds) && knownTestCaseIds.length > 0 &&
    knownTestCaseIds.every(id => typeof id === 'string' && md5.test(id)) && isRecord(testResults));
  const identities = new Set<string>();
  const ids = new Set<string>();
  for (const [key, result] of Object.entries(testResults)) {
    fields(result, ['id', 'name', 'environment', 'status', 'retries', 'labels', 'flaky', 'url', 'retryHash', 'reportLinks'], ['transition']);
    check(retryIdentity.test(key) && result.retryHash === key && typeof result.id === 'string' && md5.test(result.id) &&
      !ids.has(result.id) && typeof result.name === 'string' && /^Case [a-f0-9]{12}$/.test(result.name) &&
      result.environment === 'default' && (result.status === 'passed' || result.status === 'skipped') &&
      emptyArray(result.retries) && emptyArray(result.reportLinks) && result.url === '' && result.flaky === false &&
      (result.transition === undefined || result.transition === 'new' || result.transition === 'fixed'));
    check(Array.isArray(result.labels) && result.labels.length === 2);
    const [suiteLabel, repositoryLabel] = result.labels;
    fields(suiteLabel, ['name', 'value']);
    fields(repositoryLabel, ['name', 'value']);
    const suite = typeof suiteLabel.value === 'string' && findSuite(suiteLabel.value);
    check(suite && suiteLabel.name === 'suite' && repositoryLabel.name === 'qep.repository' && repositoryLabel.value === suite.repository);
    identities.add(key.slice(0, 32));
    ids.add(result.id);
  }
  check(identities.size === knownTestCaseIds.length && new Set(knownTestCaseIds).size === identities.size &&
    knownTestCaseIds.every(id => identities.has(id)));
  return {
    uuid: point.uuid, name: point.name, timestamp: point.timestamp, knownTestCaseIds,
    testResults: testResults as Record<string, HistoryResult>, metrics: {}, url: '',
  };
}

function readReceipt(value: unknown): HistoryReceipt {
  fields(value, ['acceptedLaunches', 'previousReportId']);
  const { acceptedLaunches, previousReportId } = value;
  check(integer(acceptedLaunches) && acceptedLaunches >= 1 && acceptedLaunches <= launchLimit);
  check(previousReportId === null || (typeof previousReportId === 'string' && digest.test(previousReportId)));
  return { acceptedLaunches, previousReportId };
}

function readHistoryEntry(storage: LocalStorage, reports: number, reportId: string): HistoryEntry | undefined {
  return storage.inspectChild(reports, reportId, directory => {
    const ctime = fstatSync(directory, { bigint: true }).ctimeNs;
    const manifest = parseReportManifest(reportManifest(storage, directory), reportId);
    if (manifest.schemaVersion === 1) {
      check(!lstatSync(join(fdPath(directory), allureHistoryName), { throwIfNoEntry: false }));
      return undefined;
    }
    const receipt = readReceipt(manifest.history);
    const bytes = storage.file(directory, allureHistoryName, entryByteLimit);
    check(Array.isArray(manifest.files));
    const historyFile = manifest.files.filter(file => isRecord(file) && file.name === allureHistoryName);
    const expected = fileDigest(allureHistoryName, bytes);
    check(historyFile.length === 1 && historyFile[0].bytes === expected.bytes && historyFile[0].sha256 === expected.sha256 &&
      fstatSync(directory, { bigint: true }).ctimeNs === ctime);
    return { reportId, receipt, point: readPoint(bytes), bytes };
  });
}

function validateJournal(journal: HistoryEntry[]) {
  const uuids = new Set<string>();
  let size = 0;
  for (const [index, entry] of journal.entries()) {
    size += entry.bytes.length;
    check(size <= historyByteLimit && index < launchLimit && entry.receipt.acceptedLaunches === index + 1 &&
      entry.receipt.previousReportId === (journal[index - 1]?.reportId ?? null) && !uuids.has(entry.point.uuid));
    uuids.add(entry.point.uuid);
  }
  return journal;
}

export function readReportHistory(storage: LocalStorage, reports: number, throughReportId?: string) {
  const journal: HistoryEntry[] = [];
  let size = 0;
  try {
    if (throughReportId) {
      // Read-only verification follows only the prefix the report rendered.
      let reportId: string | null = throughReportId;
      let laterEntry: HistoryEntry | undefined;
      while (reportId) {
        const entry = readHistoryEntry(storage, reports, reportId);
        check(entry && (!laterEntry || entry.receipt.acceptedLaunches === laterEntry.receipt.acceptedLaunches - 1));
        size += entry.bytes.length;
        check(size <= historyByteLimit);
        journal.push(entry);
        laterEntry = entry;
        reportId = entry.receipt.previousReportId;
      }
      return validateJournal(journal.reverse());
    }
    for (const reportId of entries(reports, 1024)) {
      if (!digest.test(reportId)) continue;
      const entry = readHistoryEntry(storage, reports, reportId);
      if (!entry) continue;
      size += entry.bytes.length;
      check(size <= historyByteLimit && journal.length < launchLimit);
      journal.push(entry);
    }
    return validateJournal(journal.sort((a, b) => a.receipt.acceptedLaunches - b.receipt.acceptedLaunches));
  } catch {
    throw new ReportHistoryError('Accepted report history is missing, invalid, or over its safety limit.');
  }
}

export function stageHistory(journal: readonly HistoryEntry[]) {
  const prefix = Buffer.concat(journal.map(entry => entry.bytes));
  if (journal.length >= launchLimit || prefix.length >= historyByteLimit) {
    throw new ReportHistoryError('Accepted report history has reached its safety limit.');
  }
  return prefix;
}

export function validateStagedHistory(storage: LocalStorage, stage: number, prefix: Buffer, journal: readonly HistoryEntry[], reportId: string): HistoryEntry {
  try {
    const staged = storage.file(stage, allureHistoryName, historyByteLimit);
    check(staged.subarray(0, prefix.length).equals(prefix));
    const bytes = staged.subarray(prefix.length);
    const point = readPoint(bytes);
    check(journal.every(entry => entry.point.uuid !== point.uuid));
    const receipt = { acceptedLaunches: journal.length + 1, previousReportId: journal.at(-1)?.reportId ?? null };
    return { reportId, receipt, point, bytes };
  } catch {
    throw new ReportHistoryError('Missing or invalid staged Allure history update.');
  }
}
