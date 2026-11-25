import { fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AllureGeneratorError, allureHistoryName, allureReportFiles, allureVersion, generateAllureInStage, localizeAllureHtml } from './allure-generator.js';
import { allureExportLimits, exportAllureResults, type AllureResultFile } from './allure-export.js';
import {
  fileDigest, lockReportHistory, parseReportManifest, readReportHistory, reportManifest, reportManifestName,
  ReportHistoryError, stageHistory, validateStagedHistory, type HistoryReceipt,
} from './report-history.js';
import { reportFileLimits, verifyReportOutput } from './report-output.js';
import { deriveCounts, sha256, validRunId } from './result-contract-v1.js';
import { verifyResults } from './results.js';
import { entries, fdPath, localRoot, requirePrivateDirectory, withLocalStorage, type LocalStorage } from './run-storage.js';

const policy = 'qep-audited-pass-v1';
const maxRuns = 32;
const publishedNames = [...allureReportFiles, reportManifestName];
const publishedWithHistory = [...publishedNames, allureHistoryName];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
type Action = 'plan' | 'build' | 'verify';

class ReportError extends Error {}
class UnsuccessfulRun extends ReportError {}

function selectRuns(ids: readonly string[]) {
  const verified = ids.map(runId => {
    try {
      return verifyResults(runId);
    } catch {
      return undefined;
    }
  });
  return verified.map((evidence, index) => {
    if (!evidence || evidence.result.collectionState === 'INVALID') {
      throw new ReportError(`Run ${ids[index]}: invalid or missing evidence.`);
    }
    const { run, result, manifest, manifestSha256 } = evidence;
    if (run.status !== result.executionStatus || run.exitCode !== result.childExitCode ||
        run.commitSha !== result.sourceCommit || run.suiteId !== result.suiteId) {
      throw new ReportError(`Run ${run.runId}: inconsistent execution or source identity.`);
    }
    if (run.status !== 'PASS') {
      throw new UnsuccessfulRun(`Run ${run.runId}: verified unsuccessful test execution (${run.status}, ${result.collectionState}).`);
    }
    // Contract v1 additionally requires positive passed evidence and zero failed, broken and unknown cases.
    if (result.collectionState !== 'COMPLETE' || run.exitCode !== 0) {
      throw new ReportError(`Run ${run.runId}: evidence does not satisfy the launch policy.`);
    }
    const { runId, suiteId, sourceRepository } = run;
    return {
      input: {
        runId, suiteId, sourceRepository, sourceCommit: result.sourceCommit,
        executionStatus: result.executionStatus, childExitCode: result.childExitCode,
        collectionState: result.collectionState, counts: result.counts, manifestSha256,
        resultSha256: manifest.files[0].sha256,
      },
      result,
    };
  });
}

function planReport(ids: readonly string[]) {
  const selected = selectRuns(ids);
  const runs = selected.map(item => item.input);
  const reportId = sha256(JSON.stringify(['qep-report-v1', runs.map(run => [run.runId, run.manifestSha256])]));
  const counts = deriveCounts([]);
  for (const { result } of selected) {
    counts.total += result.counts.total;
    if (counts.total > allureExportLimits.files) throw new ReportError('Report case limit exceeded.');
    counts.passed += result.counts.passed;
    counts.skipped += result.counts.skipped;
  }
  return {
    manifest: { schemaVersion: 2, reportId, policy, generator: { name: 'allure', version: allureVersion }, runs, counts },
    selected,
  };
}

function reportInputs(selected: ReturnType<typeof selectRuns>, legacy: boolean) {
  const identity = legacy ? 'execution' : { launchOccurrences: new Map<string, number>() };
  const files = new Map<string, AllureResultFile>();
  let totalBytes = 0;
  for (const { result } of selected) {
    for (const file of exportAllureResults(result, identity)) {
      if (files.has(file.name)) throw new ReportError('Duplicate Allure result identity.');
      totalBytes += file.bytes.length;
      if (totalBytes > allureExportLimits.totalBytes) throw new ReportError('Report result byte limit exceeded.');
      files.set(file.name, file);
    }
  }
  return [...files.values()];
}

type Plan = ReturnType<typeof planReport>;
type Journal = ReturnType<typeof readReportHistory>;
type Entry = Journal[number];

function checkInventory(directory: number, names: readonly string[], description: string) {
  try {
    const actual = entries(directory, names.length);
    if (actual.size === names.length && names.every(name => actual.has(name))) return;
  } catch {
    // Directory enumeration failures are treated as an invalid inventory.
  }
  throw new ReportError(`Incomplete or unexpected ${description} inventory.`);
}

function readOutput(storage: LocalStorage, directory: number) {
  return {
    'index.html': storage.file(directory, 'index.html', reportFileLimits['index.html']),
    'summary.json': storage.file(directory, 'summary.json', reportFileLimits['summary.json']),
    'test-results.json': storage.file(directory, 'test-results.json', reportFileLimits['test-results.json']),
  };
}

function validateOutput(files: ReturnType<typeof readOutput>, plan: Plan, inputs: readonly AllureResultFile[], history?: { entry: Entry; previous: Journal }) {
  try {
    const rendered = history && {
      point: history.entry.point,
      previous: history.previous.map(item => item.point).sort((a, b) => b.timestamp - a.timestamp),
    };
    return verifyReportOutput(files, inputs, plan.manifest.counts, rendered);
  } catch (error) {
    // Explicit validator diagnostics are safe. Parser exceptions can include raw bytes.
    const message = error instanceof Error ? error.message : '';
    throw new ReportError(/^(Allure report (aggregate count|case inventory) mismatch\.|(Unexpected|Incomplete) Allure [a-z -]+\.)$/.test(message)
      ? message : 'Invalid or incomplete Allure report output.');
  }
}

function publishedManifest(plan: Plan, files: ReturnType<typeof readOutput>, entry?: Entry) {
  const digests = allureReportFiles.map(name => fileDigest(name, files[name]));
  if (entry) {
    return encode({ ...plan.manifest, history: entry.receipt, files: [...digests, fileDigest(allureHistoryName, entry.bytes)] });
  }
  return encode({ ...plan.manifest, schemaVersion: 1, files: digests });
}

function verifyPublished(storage: LocalStorage, reports: number, plan: Plan, journal?: Journal) {
  const directory = storage.child(reports, plan.manifest.reportId, true);
  requirePrivateDirectory(directory);
  const ctime = fstatSync(directory, { bigint: true }).ctimeNs;
  const manifest = reportManifest(storage, directory);
  const legacy = parseReportManifest(manifest, plan.manifest.reportId).schemaVersion === 1;
  checkInventory(directory, legacy ? publishedNames : publishedWithHistory, 'published report');
  let history: { entry: Entry; previous: Journal } | undefined;
  if (!legacy) {
    const accepted = journal ?? readReportHistory(storage, reports, plan.manifest.reportId);
    const index = accepted.findIndex(item => item.reportId === plan.manifest.reportId);
    if (index < 0) throw new ReportError('Published report history is unavailable.');
    history = { entry: accepted[index], previous: accepted.slice(0, index) };
  }
  const files = readOutput(storage, directory);
  const content = validateOutput(files, plan, reportInputs(plan.selected, legacy), history);
  const expected = publishedManifest(plan, files, history?.entry);
  if (!expected.equals(manifest) || fstatSync(directory, { bigint: true }).ctimeNs !== ctime) {
    throw new ReportError('Published report manifest or file digests do not match.');
  }
  return {
    outcome: { schemaVersion: legacy ? 1 : 2, history: history?.entry.receipt },
    html: files['index.html'], content, manifest,
  };
}

export function verifyReportSelection(ids: readonly string[]) {
  const plan = planReport(ids);
  return withLocalStorage(storage => {
    const reports = storage.child(storage.local, 'reports', true);
    requirePrivateDirectory(reports);
    const verified = verifyPublished(storage, reports, plan);
    if (!verified.outcome.history) throw new ReportError('Site publication requires an accepted report history entry.');
    const { html, content, manifest, outcome: { history } } = verified;
    return { reportId: plan.manifest.reportId, html, content, manifest, history };
  });
}

function buildReport(storage: LocalStorage, reports: number, plan: Plan): { status: string; schemaVersion: number; history?: HistoryReceipt } {
  lockReportHistory(reports);
  const journal = readReportHistory(storage, reports);
  const target = join(fdPath(reports), plan.manifest.reportId);
  if (lstatSync(target, { throwIfNoEntry: false })) {
    return { status: 'reused', ...verifyPublished(storage, reports, plan, journal).outcome };
  }

  const inputs = reportInputs(plan.selected, false);
  const prefix = stageHistory(journal);
  const stagePath = mkdtempSync(join(fdPath(reports), 'pending-'));
  try {
    const stage = storage.child(reports, basename(stagePath), true);
    requirePrivateDirectory(stage);
    const inputPath = join(fdPath(stage), 'allure-results');
    mkdirSync(inputPath, { mode: 0o700 });
    const input = storage.child(stage, 'allure-results', true);
    for (const { name, bytes } of inputs) {
      writeFileSync(join(fdPath(input), name), bytes, { flag: 'wx', mode: 0o600 });
    }
    if (prefix.length) writeFileSync(join(fdPath(stage), allureHistoryName), prefix, { flag: 'wx', mode: 0o600 });
    generateAllureInStage(join(localRoot, 'reports', basename(stagePath)), { hasPreviousLaunch: journal.length > 0 });
    // Allure creates this directory using the caller's umask. The stage is 0700.
    const generated = storage.child(stage, 'report.pending');
    checkInventory(generated, allureReportFiles, 'Allure output');
    const history = validateStagedHistory(storage, stage, prefix, journal, plan.manifest.reportId);
    checkInventory(stage, ['allurerc.json', 'allure-results', 'report.pending', allureHistoryName], 'report staging');
    const retainedInput = storage.child(stage, 'allure-results', true);
    checkInventory(retainedInput, inputs.map(file => file.name), 'Allure input');
    for (const { name, bytes } of inputs) {
      if (!storage.file(retainedInput, name, allureExportLimits.fileBytes).equals(bytes)) {
        throw new ReportError('Allure generator changed the input results.');
      }
    }
    const files = readOutput(storage, generated);
    files['index.html'] = Buffer.from(localizeAllureHtml(new TextDecoder('utf-8', { fatal: true }).decode(files['index.html'])));
    if (files['index.html'].length > reportFileLimits['index.html']) throw new ReportError('Allure HTML size limit exceeded.');
    validateOutput(files, plan, inputs, { entry: history, previous: journal });
    const manifest = publishedManifest(plan, files, history);
    const currentRuns = selectRuns(plan.manifest.runs.map(run => run.runId)).map(item => item.input);
    if (!encode(currentRuns).equals(encode(plan.manifest.runs))) {
      throw new ReportError('Selected run evidence changed during generation.');
    }

    const accepted = join(fdPath(stage), 'accepted');
    mkdirSync(accepted, { mode: 0o700 });
    for (const [name, bytes] of Object.entries({ ...files, [allureHistoryName]: history.bytes, [reportManifestName]: manifest })) {
      writeFileSync(join(accepted, name), bytes, { flag: 'wx', mode: 0o600, flush: true });
    }
    fsyncSync(storage.child(stage, 'accepted', true));
    fsyncSync(storage.local);
    if (lstatSync(target, { throwIfNoEntry: false })) {
      throw new ReportError('Report destination appeared during generation.');
    }
    // A single rename commits the report, manifest and new immutable history line.
    renameSync(accepted, target);
    fsyncSync(reports);
    fsyncSync(stage);
    return { status: 'built', schemaVersion: plan.manifest.schemaVersion, history: history.receipt };
  } finally {
    rmSync(stagePath, { recursive: true, force: true });
  }
}

export function parseRunSelection(selectors: readonly string[], command: string) {
  if (selectors.length === 0 || selectors.length % 2 || selectors.length > maxRuns * 2) {
    throw new ReportError(`Supply ${command} with 1–${maxRuns} explicit --run-id <qep-run-uuid> selectors.`);
  }
  const ids = new Set<string>();
  for (let index = 0; index < selectors.length; index += 2) {
    if (selectors[index] !== '--run-id') throw new ReportError('Expected an explicit --run-id selector.');
    const runId = selectors[index + 1];
    try {
      validRunId(runId);
    } catch {
      throw new ReportError('Malformed Run ID. Expected a lowercase QEP UUIDv4.');
    }
    if (ids.has(runId)) throw new ReportError(`Duplicate Run ID ${runId}.`);
    ids.add(runId);
  }
  return [...ids].sort();
}

export function reportFailure(error: unknown, fallback: string) {
  const safe = error instanceof ReportError || error instanceof AllureGeneratorError || error instanceof ReportHistoryError;
  return { exitCode: error instanceof UnsuccessfulRun ? 1 : 2, stderr: safe ? error.message : fallback };
}

export function reportCli(args: readonly string[]) {
  let action: Action | undefined;
  try {
    const [requested, ...selectors] = args;
    const usage = 'report plan|build|verify';
    if (requested !== 'plan' && requested !== 'build' && requested !== 'verify') {
      throw new ReportError(`Supply ${usage} with 1–${maxRuns} explicit --run-id <qep-run-uuid> selectors.`);
    }
    action = requested;
    const plan = planReport(parseRunSelection(selectors, usage));
    const directory = '.local/reports/' + plan.manifest.reportId;
    const outcome = action === 'plan' ? { status: 'planned' } : withLocalStorage(storage => {
      const path = join(fdPath(storage.local), 'reports');
      if (action === 'build') {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const reports = storage.child(storage.local, 'reports', true);
      requirePrivateDirectory(reports);
      if (action === 'build') return buildReport(storage, reports, plan);
      return { status: 'verified', ...verifyPublished(storage, reports, plan).outcome };
    });
    if (action === 'plan') reportInputs(plan.selected, false);
    return { exitCode: 0, stdout: JSON.stringify({ acceptance: 'verified-successful-launch', directory, ...plan.manifest, ...outcome }) };
  } catch (error) {
    return reportFailure(error, action === 'verify' ? 'Invalid or unavailable report.' : 'Unable to assemble the report.');
  }
}
