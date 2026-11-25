import { fstatSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AllureGeneratorError, allureReportFiles, allureVersion, generateAllureInStage, localizeAllureHtml } from './allure-generator.js';
import { allureExportLimits, exportAllureResults, type AllureResultFile } from './allure-export.js';
import { reportFileLimits, verifyReportOutput } from './report-output.js';
import { deriveCounts, sha256, validRunId } from './result-contract-v1.js';
import { verifyResults } from './results.js';
import { entries, fdPath, localRoot, requirePrivateDirectory, withLocalStorage, type LocalStorage } from './run-storage.js';

const policy = 'qep-audited-pass-v1';
const maxRuns = 32;
const manifestName = 'report-manifest.json';
const publishedNames = [...allureReportFiles, manifestName];
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
  const files = new Map<string, AllureResultFile>();
  let totalBytes = 0;
  for (const { result } of selected) {
    counts.total += result.counts.total;
    if (counts.total > allureExportLimits.files) throw new ReportError('Report case limit exceeded.');
    counts.passed += result.counts.passed;
    counts.skipped += result.counts.skipped;
    for (const file of exportAllureResults(result, 'execution')) {
      if (files.has(file.name)) throw new ReportError('Duplicate Allure result identity.');
      totalBytes += file.bytes.length;
      if (totalBytes > allureExportLimits.totalBytes) throw new ReportError('Report result byte limit exceeded.');
      files.set(file.name, file);
    }
  }
  return {
    manifest: { schemaVersion: 1, reportId, policy, generator: { name: 'allure', version: allureVersion },
      runs, counts },
    files: [...files.values()],
  };
}

type Plan = ReturnType<typeof planReport>;

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

function validateOutput(files: ReturnType<typeof readOutput>, plan: Plan) {
  try {
    verifyReportOutput(files, plan.files, plan.manifest.counts);
  } catch (error) {
    // Explicit validator diagnostics are safe. Parser exceptions can include raw bytes.
    const message = error instanceof Error ? error.message : '';
    throw new ReportError(/^(Allure report (aggregate count|case inventory) mismatch\.|(Unexpected|Incomplete) Allure [a-z -]+\.)$/.test(message)
      ? message : 'Invalid or incomplete Allure report output.');
  }
  return encode({
    ...plan.manifest,
    files: allureReportFiles.map(name => ({ name, bytes: files[name].length, sha256: sha256(files[name]) })),
  });
}

function verifyPublished(storage: LocalStorage, reports: number, plan: Plan) {
  const directory = storage.child(reports, plan.manifest.reportId, true);
  requirePrivateDirectory(directory);
  const ctime = fstatSync(directory, { bigint: true }).ctimeNs;
  checkInventory(directory, publishedNames, 'published report');
  const manifest = storage.file(directory, manifestName, 1024 * 1024);
  const expected = validateOutput(readOutput(storage, directory), plan);
  if (!expected.equals(manifest) || fstatSync(directory, { bigint: true }).ctimeNs !== ctime) {
    throw new ReportError('Published report manifest or file digests do not match.');
  }
}

function buildReport(storage: LocalStorage, reports: number, plan: Plan) {
  const target = join(fdPath(reports), plan.manifest.reportId);
  if (lstatSync(target, { throwIfNoEntry: false })) {
    verifyPublished(storage, reports, plan);
    return 'reused';
  }

  const stagePath = mkdtempSync(join(fdPath(reports), 'pending-'));
  try {
    const stage = storage.child(reports, basename(stagePath), true);
    requirePrivateDirectory(stage);
    const inputPath = join(fdPath(stage), 'allure-results');
    mkdirSync(inputPath, { mode: 0o700 });
    const input = storage.child(stage, 'allure-results', true);
    for (const { name, bytes } of plan.files) {
      writeFileSync(join(fdPath(input), name), bytes, { flag: 'wx', mode: 0o600 });
    }
    generateAllureInStage(join(localRoot, 'reports', basename(stagePath)));
    checkInventory(stage, ['allurerc.json', 'allure-results', 'report.pending'], 'report staging');
    const retainedInput = storage.child(stage, 'allure-results', true);
    checkInventory(retainedInput, plan.files.map(file => file.name), 'Allure input');
    for (const { name, bytes } of plan.files) {
      if (!storage.file(retainedInput, name, allureExportLimits.fileBytes).equals(bytes)) {
        throw new ReportError('Allure generator changed the input results.');
      }
    }
    // Allure creates this directory using the caller's umask. The stage is 0700.
    const generated = storage.child(stage, 'report.pending');
    checkInventory(generated, allureReportFiles, 'Allure output');
    const files = readOutput(storage, generated);
    files['index.html'] = Buffer.from(localizeAllureHtml(new TextDecoder('utf-8', { fatal: true }).decode(files['index.html'])));
    if (files['index.html'].length > reportFileLimits['index.html']) throw new ReportError('Allure HTML size limit exceeded.');
    const manifest = validateOutput(files, plan);
    const currentRuns = selectRuns(plan.manifest.runs.map(run => run.runId)).map(item => item.input);
    if (!encode(currentRuns).equals(encode(plan.manifest.runs))) {
      throw new ReportError('Selected run evidence changed during generation.');
    }

    const accepted = join(fdPath(stage), 'accepted');
    mkdirSync(accepted, { mode: 0o700 });
    for (const name of allureReportFiles) {
      writeFileSync(join(accepted, name), files[name], { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(accepted, manifestName), manifest, { flag: 'wx', mode: 0o600 });
    try {
      // An accepted target is nonempty, so a concurrent rename cannot replace it.
      if (!lstatSync(target, { throwIfNoEntry: false })) {
        renameSync(accepted, target);
        return 'built';
      }
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    verifyPublished(storage, reports, plan);
    return 'reused';
  } finally {
    rmSync(stagePath, { recursive: true, force: true });
  }
}

function parseSelection(args: readonly string[]): { action: Action; ids: string[] } {
  const [action, ...selectors] = args;
  if ((action !== 'plan' && action !== 'build' && action !== 'verify') || selectors.length === 0 ||
      selectors.length % 2 || selectors.length > maxRuns * 2) {
    throw new ReportError(`Supply report plan|build|verify with 1–${maxRuns} explicit --run-id <qep-run-uuid> selectors.`);
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
  return { action, ids: [...ids].sort() };
}

export function reportCli(args: readonly string[]) {
  let action: Action | undefined;
  try {
    const selection = parseSelection(args);
    action = selection.action;
    const plan = planReport(selection.ids);
    const directory = '.local/reports/' + plan.manifest.reportId;
    const status = action === 'plan' ? 'planned' : withLocalStorage(storage => {
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
      verifyPublished(storage, reports, plan);
      return 'verified';
    });
    return { exitCode: 0, stdout: JSON.stringify({ status, acceptance: 'verified-successful-launch', directory, ...plan.manifest }) };
  } catch (error) {
    const safe = error instanceof ReportError || error instanceof AllureGeneratorError;
    return {
      exitCode: error instanceof UnsuccessfulRun ? 1 : 2,
      stderr: safe ? error.message : action === 'verify' ? 'Invalid or unavailable report.' : 'Unable to assemble the report.',
    };
  }
}
