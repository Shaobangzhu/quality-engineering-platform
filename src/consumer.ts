import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToSignals } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { archiveLimit, exactVersion, jsonLimit } from './clu-candidate-archive.js';
import { checkCluOrigin, inspectCluCandidate, receiptFor, verifyCluBuild, verifyPackedCandidate } from './clu-candidate.js';
import { collectDgi, dgiSummary } from './dgi-allure.js';
import { applyDgiCandidate, checkDgiOrigin, equalBytes, verifyDgiDependencies, verifyInstalled, verifyInstalledPackage } from './dgi-candidate.js';
import { lockFile, planCandidateDelta, readInstalledLock, regularBytes } from './dgi-candidate-lock.js';
import { checkInstall, verifyDependencies, verifyInstalledTool } from './install-policy.js';
import { isRecord, readManifest } from './metadata.js';
import { installedNpm } from './plan.js';
import { lockRuntime, writeSummary } from './run-control.js';
import { childEnvironment, inspectDgiChain, inspectSuite, reviewedScript, verifyCheckout } from './run-policy.js';
import { Blocked, cancellation, runProcess, type Outcome } from './run-process.js';
import { requirePrivateDirectory, withLocalStorage } from './run-storage.js';
import { readSummary } from './run-summary.js';
import type { ResultContractV1 } from './result-contract-v1.js';
import { gitInvocation } from './source-git.js';
import { initializeWorkspaceStorage, inspectWorkspace, reserveWorkspace, verifyDetachedWorkspace, verifyWorkspaceSource, workspaceCloneArgs,
  type Workspace } from './workspace.js';

const storage = 'consumer-gate';
const selectors = ['clu-source', 'clu-sha', 'dgi-source', 'dgi-sha'] as const;
const defaultTimeout = 300_000;
const installArgs = ['ci', '--ignore-scripts', '--include=dev'] as const;
const cluCommands = {
  version: ['--version'], test: ['test', '--ignore-scripts'], build: ['run', 'build', '--ignore-scripts'],
  pack: ['pack', '--ignore-scripts', '--json', '--pack-destination'],
} as const;
const dgiCommands = {
  typecheck: ['run', 'typecheck', '-w', 'frontend'],
  build: ['run', 'build', '-w', 'frontend', '--', '--mode', 'quality'],
  test: ['run', 'test:frontend'],
} as const;
const dgiChecks = ['typecheck', 'build', 'test'] as const;
const dgiTools = ['tsc', 'vite', 'vitest'];
const work = 'work';
const stageNames = ['clu', 'baseline', 'candidate'] as const;
type StageName = typeof stageNames[number];
type Step = { name: string } & Outcome;
type Stage = {
  steps: Step[];
  tests?: { counts: ResultContractV1['counts']; casesSha256: string };
  dependencies?: { lockSha256: string; clu: ReturnType<typeof planCandidateDelta>['published'];
    reactVersion: string; installed?: Awaited<ReturnType<typeof verifyInstalled>>; verified: boolean };
};

function requestFor(args: readonly string[]) {
  const [command, ...options] = args;
  if (command !== 'plan' && command !== 'run') throw new Error('Supply consumer plan or consumer run.');
  const { values } = parseArgs({ args: options, options: {
    'clu-source': { type: 'string', multiple: true }, 'clu-sha': { type: 'string', multiple: true },
    'dgi-source': { type: 'string', multiple: true }, 'dgi-sha': { type: 'string', multiple: true },
    execute: { type: 'boolean', multiple: true }, 'install-deps': { type: 'boolean', multiple: true },
    'timeout-ms': { type: 'string', multiple: true },
  } });
  if (selectors.some(selector => values[selector]?.length !== 1)) {
    throw new Error('Supply --clu-source, --clu-sha, --dgi-source and --dgi-sha once each.');
  }
  if ([values.execute, values['install-deps'], values['timeout-ms']].some(value => (value?.length ?? 0) > 1)) {
    throw new Error('Supply execution options at most once.');
  }
  const execute = Boolean(values.execute);
  if ((command === 'plan' && execute) || (!execute && (values['install-deps'] || values['timeout-ms']))) {
    throw new Error('Execution options require consumer run --execute.');
  }
  if (execute && !values['install-deps']) throw new Error('Consumer execution requires --install-deps.');
  const timeout = values['timeout-ms']?.[0] ?? String(defaultTimeout);
  if (!/^[1-9][0-9]*$/.test(timeout) || Number(timeout) > 1_800_000) {
    throw new Error('--timeout-ms must be an integer from 1 through 1800000.');
  }
  return { execute, timeout: Number(timeout), clu: { suite: 'clu-unit', source: values['clu-source']![0]!, sha: values['clu-sha']![0]! },
    dgi: { suite: 'dgi-frontend-unit', source: values['dgi-source']![0]!, sha: values['dgi-sha']![0]! } };
}

function inspectDgi(preparation: ReturnType<typeof inspectWorkspace>) {
  const { source, suite } = preparation;
  const manifest = readManifest(join(source.path, 'package.json'), 'DGI package.json');
  const { workspaceManifests } = inspectDgiChain(source.path, source.sha, suite, manifest);
  const frontend = workspaceManifests.get('frontend')!;
  if (reviewedScript(frontend, 'typecheck') !== 'tsc --noEmit' ||
      reviewedScript(frontend, 'build') !== 'tsc --noEmit && vite build') {
    throw new Blocked('unsupported-profile');
  }
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const blocked = (failureCategory: NonNullable<Outcome['failureCategory']>): Outcome =>
  ({ status: 'BLOCKED', exitCode: null, cliCode: 2, failureCategory });

class Stopped extends Error {
  constructor(readonly stage: StageName, readonly step: Step) { super(step.name); }
}

function ordinaryFailure(step: Outcome) {
  return step.status === 'FAIL' &&
    (step.failureCategory === 'exit-nonzero' || step.failureCategory === 'failed-evidence' || step.failureCategory === 'missing-evidence');
}

function compare(baseline: Stage, candidate: Stage) {
  const failed = (stage: Stage) => stage.steps.find(step => step.status !== 'PASS');
  const baselineFailure = failed(baseline);
  if (baselineFailure) return { status: 'BASELINE_FAILED', reason: baselineFailure.name, exitCode: baselineFailure.cliCode };
  const candidateFailure = failed(candidate);
  if (candidateFailure) return {
    status: candidateFailure.failureCategory === 'exit-nonzero' ? 'REGRESSION' : 'BLOCKED',
    reason: candidateFailure.failureCategory, exitCode: candidateFailure.cliCode,
  };
  const before = baseline.tests;
  const after = candidate.tests;
  if (!before || !after) return { status: 'BLOCKED', reason: 'missing-evidence', exitCode: 1 };
  if (!isDeepStrictEqual(before.counts, after.counts) || before.casesSha256 !== after.casesSha256) {
    return { status: 'REGRESSION', reason: 'test-counts-or-case-statuses', exitCode: 1 };
  }
  return { status: 'PASS', reason: null, exitCode: 0 };
}

function readFrontendTests(name: 'baseline' | 'candidate', run: Workspace, startedAt: number, outcome: Outcome) {
  const endedAt = Date.now();
  const summary = Buffer.from(JSON.stringify({ runId: run.runId, suiteId: run.suiteId, sourceRepository: run.source.repository,
    commitSha: run.source.sha, runtimeVersion: process.version, startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(), durationMs: endedAt - startedAt, phase: 'test', status: outcome.status,
    exitCode: outcome.exitCode, failureCategory: outcome.failureCategory }));
  return withLocalStorage(local => {
    const gate = local.child(local.local, storage, true);
    const evaluation = local.child(gate, run.runId, true);
    const stage = local.child(local.child(evaluation, work, true), name, true);
    const { result } = collectDgi({ run: stage, child: local.child, file: local.file },
      dgiSummary(readSummary(summary, run.runId)), summary.length);
    return { counts: result.counts, casesSha256: sha256(JSON.stringify(result.cases.map(({ caseId, status }) => ({ caseId, status })))) };
  });
}

function requirePublishedClu(workspace: string, plan: ReturnType<typeof planCandidateDelta>) {
  const lock = readInstalledLock(workspace);
  const installed = isRecord(lock.packages) ? lock.packages[plan.packageLocation] : undefined;
  if (lock.lockfileVersion !== 3 || !isRecord(installed) ||
      !Object.entries(plan.published).every(([key, value]) => installed[key] === value)) throw new Blocked('integrity');
}

// Vite and Vitest can leave caches in node_modules after supervised execution.
// Clear their fixed locations before checking the installed package inventory.
function clearViteCaches(workspace: string, roots: readonly string[]) {
  for (const root of roots) {
    const modules = join(workspace, root);
    const stat = lstatSync(modules, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory()) throw new Blocked('integrity');
    for (const name of ['.vite', '.vite-temp']) {
      const cache = join(modules, name);
      const directory = lstatSync(cache, { throwIfNoEntry: false });
      if (!directory) continue;
      if (!directory.isDirectory()) throw new Blocked('integrity');
      rmSync(cache, { recursive: true });
    }
  }
}

async function executeConsumer(clu: ReturnType<typeof inspectWorkspace>, dgi: typeof clu, timeout: number) {
  if (process.platform !== 'linux') throw new Error('Consumer execution requires Linux process groups and procfs.');
  initializeWorkspaceStorage(clu);
  withLocalStorage(local => requirePrivateDirectory(local.child(local.local, storage, true)));
  const release = lockRuntime(clu.runs);
  const abort = new AbortController();
  const interrupt = () => abort.abort('SIGINT');
  const terminate = () => abort.abort('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let cleanupSafe = true;
  try {
    const run = reserveWorkspace(clu);
    const workPath = join(run.runPath, work);
    const summaryPath = join(run.runPath, 'summary.json');
    const startedAt = new Date().toISOString();
    const stages: Record<StageName, Stage> = { clu: { steps: [] }, baseline: { steps: [] }, candidate: { steps: [] } };
    const npm = installedNpm();
    let receipt: ReturnType<typeof receiptFor> | undefined;

    function record(stage: StageName, name: string, outcome: Outcome, continueOnFailure = false) {
      const step = { name, ...outcome };
      stages[stage].steps.push(step);
      if (step.failureCategory === 'cleanup') cleanupSafe = false;
      if (step.status !== 'PASS' && !(continueOnFailure && ordinaryFailure(step))) throw new Stopped(stage, step);
    }

    function verify<T>(stage: StageName, name: string, check: () => T): T {
      try { return check(); }
      catch (error) {
        throw new Stopped(stage, { name, ...blocked(error instanceof Blocked ? error.category : 'integrity') });
      }
    }

    async function snapshot(stage: StageName, preparation: typeof clu) {
      await yieldToSignals();
      if (abort.signal.aborted) throw new Stopped(stage, { name: 'checkout', ...cancellation(abort.signal.reason, null) });
      const runPath = join(workPath, stage);
      const workspace = join(runPath, 'workspace');
      const instance = { ...run, runPath, workspace, suiteId: preparation.suite.id, source: preparation.source };
      verify(stage, 'checkout', () => mkdirSync(runPath, { mode: 0o700 }));
      async function gitStep(cwd: string, args: readonly string[], name: string, clone = false) {
        await yieldToSignals();
        const git = gitInvocation(cwd, args, clone);
        const outcome = await runProcess('git', git.args, '/', git.env, timeout, abort.signal, false);
        if (outcome.failureCategory === 'install-failed') outcome.failureCategory = 'exit-nonzero';
        record(stage, name, outcome);
      }
      await gitStep('/', workspaceCloneArgs(instance), 'clone', true);
      await gitStep(workspace, ['checkout', '--detach', preparation.source.sha, '--'], 'checkout');
      verify(stage, 'checkout-provenance', () => verifyDetachedWorkspace(instance));
      await gitStep(workspace, ['remote', 'remove', 'origin'], 'remove-origin');
      return verify(stage, 'checkout', () => {
        verifyWorkspaceSource(preparation);
        verifyCheckout(instance, preparation.suite, []);
        const env = { ...childEnvironment(runPath), npm_config_registry: 'https://registry.npmjs.org/',
          npm_config_script_shell: '/bin/sh' };
        return { instance, workspace, env };
      });
    }

    type Snapshot = Awaited<ReturnType<typeof snapshot>>;
    async function npmStep(directory: Snapshot, args: readonly string[], format: Parameters<typeof runProcess>[6] = false,
      collect?: (chunk: string) => void, onAuditedFrontendPasses?: (passes: number) => void) {
      await yieldToSignals();
      const { workspace, env } = directory;
      const outcome = await runProcess(process.execPath, [npm.executable, ...args], workspace,
        args === dgiCommands.build ? { ...env, NODE_ENV: 'production' } : env, timeout, abort.signal, format, collect,
        onAuditedFrontendPasses);
      if (args !== installArgs && outcome.failureCategory === 'install-failed') outcome.failureCategory = 'exit-nonzero';
      return outcome;
    }

    async function capture(directory: Snapshot, name: string, args: readonly string[]) {
      let output = '';
      let overflow = false;
      const outcome = await npmStep(directory, args, false, chunk => {
        if (output.length + chunk.length > jsonLimit) overflow = true;
        if (!overflow) output += chunk;
      });
      record('clu', name, outcome);
      return verify('clu', name + '-output', () => {
        if (overflow) throw new Blocked('integrity');
        return output;
      });
    }

    async function produce() {
      const directory = await snapshot('clu', clu);
      const { instance, workspace } = directory;
      const { manifest, profile, install } = verify('clu', 'install-policy', () => {
        checkCluOrigin(clu.source.path);
        const manifest = inspectCluCandidate(workspace);
        const profile = inspectSuite(instance, clu.suite);
        return { manifest, profile, install: checkInstall(workspace, profile) };
      });
      const version = (await capture(directory, 'npm-version', cluCommands.version)).trim();
      if (!exactVersion(version) || version !== npm.version) throw new Stopped('clu', { name: 'npm-version', ...blocked('integrity') });
      record('clu', 'install', await npmStep(directory, installArgs));
      verify('clu', 'verify-install', () => {
        verifyCheckout(instance, clu.suite, install.roots);
        verifyDependencies(workspace, profile, install);
        verifyInstalledTool(workspace, 'vite', '');
      });
      record('clu', 'test', await npmStep(directory, cluCommands.test, profile.format));
      verify('clu', 'verify-test', () => {
        verifyCheckout(instance, clu.suite, install.roots);
        clearViteCaches(workspace, install.roots);
        verifyDependencies(workspace, profile, install);
        verifyInstalledTool(workspace, 'vite', '');
      });
      record('clu', 'build', await npmStep(directory, cluCommands.build));
      const packPath = join(instance.runPath, 'pack');
      verify('clu', 'verify-build', () => {
        verifyCheckout(instance, clu.suite, [...install.roots, 'dist']);
        clearViteCaches(workspace, install.roots);
        verifyCluBuild(workspace);
        mkdirSync(packPath, { mode: 0o700 });
      });
      const output = await capture(directory, 'pack', [...cluCommands.pack, packPath]);
      return verify('clu', 'verify-archive', () => {
        verifyCheckout(instance, clu.suite, [...install.roots, 'dist']);
        const result = verifyPackedCandidate(packPath, manifest, output, () => regularBytes(join(packPath, 'candidate.tgz'), archiveLimit));
        receipt = receiptFor(clu.source.sha, manifest.version, version, result.bytes);
        writeFileSync(join(run.runPath, receipt.archive), result.bytes, { flag: 'wx', mode: 0o400 });
        return result;
      });
    }

    async function runFrontend(stage: 'baseline' | 'candidate', directory: Snapshot,
      plan: ReturnType<typeof planCandidateDelta>, producer?: Awaited<ReturnType<typeof produce>>) {
      const { instance, workspace, env } = directory;
      const { profile, install } = producer ? plan : plan.baseline;
      const lock = plan.files.find(file => file.path === lockFile)!;
      const dependencies: NonNullable<Stage['dependencies']> = { lockSha256: sha256(producer ? lock.after : lock.before),
        clu: producer ? plan.candidateEntry : plan.published, reactVersion: plan.reactVersion, verified: false };
      stages[stage].dependencies = dependencies;
      verify(stage, 'dependency-plan', () => {
        if (producer) applyDgiCandidate(workspace, plan, producer.bytes);
        verifyDgiDependencies(instance, dgi.suite, plan, [], producer?.bytes);
      });
      record(stage, 'install', await npmStep(directory, installArgs));
      const outputs: string[] = [];
      const verifyTree = () => verify(stage, 'checkout-integrity', () => {
        for (const output of outputs) {
          const path = join(workspace, output);
          const stat = lstatSync(path, { throwIfNoEntry: false });
          if (stat && !stat.isDirectory()) throw new Blocked('integrity');
          if (stat && output === 'artifacts' && readdirSync(path, { withFileTypes: true }).some(entry =>
            !entry.isDirectory() || (entry.name !== '.allure-raw' && entry.name !== 'allure-results'))) {
            throw new Blocked('integrity');
          }
        }
        verifyDgiDependencies(instance, dgi.suite, plan, [...install.roots, ...outputs], producer?.bytes);
      });
      function verifyInstall() {
        verify(stage, 'dependency-integrity', () => {
          if (producer) verifyInstalledPackage(workspace, plan, producer.archive);
          else {
            verifyDependencies(workspace, { ...profile, tool: 'node', toolWorkspace: '' }, install);
            requirePublishedClu(workspace, plan);
          }
          for (const tool of dgiTools) verifyInstalledTool(workspace, tool, 'frontend');
        });
      }
      verifyTree();
      if (producer) {
        try {
          const installed = await verifyInstalled(workspace, plan, producer.archive, async (args, cwd, collect) => {
            await yieldToSignals();
            record(stage, 'resolve-exports', await runProcess(process.execPath, args, cwd, env, timeout, abort.signal, false, collect));
          });
          dependencies.installed = { javascript: installed.javascript.slice(workspace.length + 1),
            declaration: installed.declaration.slice(workspace.length + 1), stylesheet: installed.stylesheet.slice(workspace.length + 1),
            react: installed.react.slice(workspace.length + 1), reactVersion: installed.reactVersion };
        } catch (error) {
          if (error instanceof Stopped) throw error;
          throw new Stopped(stage, { name: 'candidate-identity', ...blocked('integrity') });
        }
      }
      verifyInstall();
      for (const name of dgiChecks) {
        if (name === 'build') outputs.push('frontend/dist');
        if (name === 'test') {
          outputs.push('artifacts', 'reports');
          verify(stage, 'report-directory', () => mkdirSync(join(workspace, 'reports'), { mode: 0o700 }));
        }
        const start = Date.now();
        let consolePasses: number | undefined;
        let outcome = await npmStep(directory, dgiCommands[name], name === 'test' ? 'dgi-frontend-allure' : false,
          undefined, passes => { consolePasses = passes; });
        if (name === 'test' && (outcome.status === 'PASS' || ordinaryFailure(outcome))) {
          try {
            const tests = readFrontendTests(stage, instance, start, outcome);
            stages[stage].tests = tests;
            if (outcome.status === 'PASS' && tests.counts.passed !== consolePasses) {
              outcome = { ...outcome, status: 'FAIL', cliCode: 1, failureCategory: 'failed-evidence' };
            }
          }
          catch {
            if (outcome.status === 'PASS') outcome = { ...outcome, status: 'FAIL', cliCode: 1, failureCategory: 'missing-evidence' };
          }
        }
        record(stage, name, outcome, true);
        verifyTree();
      }
      verify(stage, 'clear-vite-caches', () => clearViteCaches(workspace, install.roots));
      verifyInstall();
      dependencies.verified = true;
    }

    let result;
    let stopped: { stage: StageName; step: Step } | undefined;
    const workDirectory = () => lstatSync(workPath, { bigint: true });
    const reservation = lstatSync(run.runPath, { bigint: true });
    mkdirSync(workPath, { mode: 0o700 });
    const scratch = workDirectory();
    try {
      const producer = await produce();
      const baseline = await snapshot('baseline', dgi);
      const plan = verify('baseline', 'dependency-plan', () => planCandidateDelta(baseline.workspace, producer.archive));
      await runFrontend('baseline', baseline, plan);
      const candidate = await snapshot('candidate', dgi);
      await runFrontend('candidate', candidate, plan, producer);
      verify('candidate', 'source-provenance', () => {
        verifyWorkspaceSource(clu);
        verifyWorkspaceSource(dgi);
        checkCluOrigin(clu.source.path);
        checkDgiOrigin(dgi.source.path);
        equalBytes(join(run.runPath, 'candidate.tgz'), producer.bytes, 'The retained CLU tarball changed.');
      });
      result = compare(stages.baseline, stages.candidate);
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      const { stage, step } = error;
      if (!stages[stage].steps.includes(step)) stages[stage].steps.push(step);
      stopped = { stage, step };
      const status = step.status === 'FAIL' ? (stage === 'clu' ? 'PRODUCER_FAILED' :
        stage === 'baseline' ? 'BASELINE_FAILED' : 'BLOCKED') : step.status;
      result = { status, reason: step.failureCategory, exitCode: step.cliCode };
    }
    if (result.status !== 'TIMEOUT' && result.status !== 'CANCELLED' && cleanupSafe) {
      const firstNonzero = stageNames.flatMap(name => stages[name].steps).find(step => step.exitCode !== null && step.exitCode !== 0);
      if (firstNonzero) result.exitCode = firstNonzero.exitCode!;
    }
    await yieldToSignals();
    if (abort.signal.aborted && cleanupSafe && result.status !== 'TIMEOUT') {
      const signal = cancellation(abort.signal.reason, null);
      result = { status: signal.status, reason: signal.failureCategory, exitCode: signal.cliCode };
    }
    const current = lstatSync(run.runPath, { bigint: true });
    if (current.dev !== reservation.dev || current.ino !== reservation.ino) throw new Error('Evaluation storage ownership changed.');
    if (cleanupSafe) {
      try {
        const owned = workDirectory();
        if (owned.dev !== scratch.dev || owned.ino !== scratch.ino) throw new Error('Evaluation workspace ownership changed.');
        rmSync(workPath, { recursive: true });
      } catch {
        cleanupSafe = false;
        result = { status: 'BLOCKED', reason: 'cleanup', exitCode: 2 };
      }
    }
    const summary = { schemaVersion: 1, evaluationId: run.runId, startedAt, endedAt: new Date().toISOString(),
      node: process.version, npm: npm.version, timeoutMs: timeout, sources: { clu: clu.source, dgi: dgi.source },
      producer: receipt, stages, stopped, ...result };
    writeSummary(summaryPath, Buffer.from(JSON.stringify(summary, null, 2) + '\n'));
    const message = JSON.stringify({ summaryPath, ...summary }, null, 2);
    return result.exitCode === 0 ? { exitCode: 0, stdout: message } : { exitCode: result.exitCode, stderr: message };
  } finally {
    try { release(cleanupSafe); } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  }
}

export async function consumerCli(args: readonly string[]) {
  const request = requestFor(args);
  const clu = inspectWorkspace(request.clu, storage);
  checkCluOrigin(clu.source.path);
  inspectCluCandidate(clu.source.path);
  const dgi = inspectWorkspace(request.dgi, storage);
  checkDgiOrigin(dgi.source.path);
  inspectDgi(dgi);
  if (request.execute) return executeConsumer(clu, dgi, request.timeout);
  return { exitCode: 0, stdout: JSON.stringify({ mode: 'plan', sources: { clu: clu.source, dgi: dgi.source },
    executionRequires: ['--execute', '--install-deps'], timeoutMs: request.timeout,
    workspace: '.local/consumer-gate/<evaluation-id>/work',
    stages: [
      { name: 'clu', commands: [cluCommands.version, installArgs, cluCommands.test, cluCommands.build,
        [...cluCommands.pack, '<private-pack-directory>']] },
      { name: 'baseline', dependency: 'published CLU from the original lockfile', commands: [installArgs, ...Object.values(dgiCommands)] },
      { name: 'candidate', dependency: 'exact archive from the CLU stage', commands: [installArgs, ...Object.values(dgiCommands)] },
      { name: 'compare' },
    ], executable: 'npm',
  }, null, 2) };
}
