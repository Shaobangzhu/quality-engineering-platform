import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToSignals } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import packageMetadata from '#package' with { type: 'json' };
import { archiveLimit, exactVersion, jsonLimit } from './clu-candidate-archive.js';
import { checkCluOrigin, inspectCluCandidate, receiptFor, verifyCluBuild, verifyPackedCandidate } from './clu-candidate.js';
import { consumerStorage as storage, sealConsumerEvidence, summarizeConsumer, verifyConsumerCli } from './consumer-evidence.js';
import { deriveDecision, derivePhase, ordinaryFailure, phases, type ConsumerGateV1, type FrontendTests,
  type GateStep as Step, type PhaseName as StageName, type RecordInputs } from './consumer-gate-v1.js';
import { collectDgi, dgiSummary } from './dgi-allure.js';
import { applyDgiCandidate, checkDgiOrigin, equalBytes, verifyDgiDependencies, verifyInstalledExports, verifyInstalledPackage } from './dgi-candidate.js';
import { lockFile, planCandidateDelta, readInstalledLock, regularBytes } from './dgi-candidate-lock.js';
import { checkInstall, verifyDependencies, verifyInstalledTool } from './install-policy.js';
import { isRecord, readManifest } from './metadata.js';
import { installedNpm } from './plan.js';
import { lockRuntime } from './run-control.js';
import { childEnvironment, inspectDgiChain, inspectSuite, reviewedScript, verifyCheckout } from './run-policy.js';
import { Blocked, runProcess, type Outcome } from './run-process.js';
import { requirePrivateDirectory, withLocalStorage } from './run-storage.js';
import { readSummary } from './run-summary.js';
import { gitInvocation } from './source-git.js';
import { initializeWorkspaceStorage, inspectWorkspace, reserveWorkspace, verifyDetachedWorkspace, verifyWorkspaceSource, workspaceCloneArgs,
  type Workspace } from './workspace.js';

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
  const { workspaceManifests } = inspectDgiChain(source.path, source.sha, suite, manifest, 'consumer');
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

function readFrontendTests(name: 'baseline' | 'candidate', run: Workspace, startedAt: number, outcome: Outcome): FrontendTests {
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
      dgiSummary(readSummary(summary, run.runId, 'consumer')), summary.length);
    const cases = result.cases.map(({ caseId, status }) => ({ caseId, status }));
    return { counts: result.counts, casesSha256: sha256(JSON.stringify(cases)), cases };
  });
}

function requirePublishedClu(workspace: string, plan: ReturnType<typeof planCandidateDelta>) {
  const lock = readInstalledLock(workspace);
  const installed = isRecord(lock.packages) ? lock.packages[plan.packageLocation] : undefined;
  if (lock.lockfileVersion !== 3 || !isRecord(installed) ||
      !Object.entries(plan.published).every(([key, value]) => installed[key] === value)) throw new Blocked('integrity');
  return plan.published;
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
    const phase = () => ({ status: 'BLOCKED' as const, checkoutSha: null, steps: [], observedPasses: null });
    const observations: RecordInputs['phases'] = { clu: phase(), baseline: { ...phase(), tests: null, published: null },
      candidate: { ...phase(), tests: null, installed: null, exports: null } };
    const npm = installedNpm();
    let receipt: ReturnType<typeof receiptFor> | undefined;
    let archive: Buffer | undefined;
    let locks: { before: Buffer; after: Buffer } | undefined;
    let plan: ReturnType<typeof planCandidateDelta> | undefined;

    function record(stage: StageName, name: string, outcome: Outcome, continueOnFailure = false) {
      const step = { name, ...outcome };
      if (name !== 'install' && step.failureCategory === 'install-failed') step.failureCategory = 'exit-nonzero';
      observations[stage].steps.push(step);
      if (step.failureCategory === 'cleanup') cleanupSafe = false;
      if (step.status !== 'PASS' && !(continueOnFailure && ordinaryFailure(step))) throw new Stopped(stage, step);
    }

    function verify<T>(stage: StageName, name: string, check: () => T): T {
      try {
        const value = check();
        observations[stage].steps.push({ name, status: 'PASS', exitCode: null, cliCode: 0, failureCategory: null });
        return value;
      }
      catch (error) {
        throw new Stopped(stage, { name, ...blocked(error instanceof Blocked ? error.category : 'integrity') });
      }
    }

    async function snapshot(stage: StageName, preparation: typeof clu) {
      const runPath = join(workPath, stage);
      const workspace = join(runPath, 'workspace');
      const instance = { ...run, runPath, workspace, suiteId: preparation.suite.id, source: preparation.source };
      verify(stage, 'prepare-checkout', () => mkdirSync(runPath, { mode: 0o700 }));
      async function gitStep(cwd: string, args: readonly string[], name: string, clone = false) {
        await yieldToSignals();
        const git = gitInvocation(cwd, args, clone);
        const outcome = await runProcess('git', git.args, '/', git.env, timeout, abort.signal, false);
        record(stage, name, outcome);
      }
      await gitStep('/', workspaceCloneArgs(instance), 'clone', true);
      await gitStep(workspace, ['checkout', '--detach', preparation.source.sha, '--'], 'checkout');
      observations[stage].checkoutSha = verify(stage, 'checkout-provenance', () => verifyDetachedWorkspace(instance));
      await gitStep(workspace, ['remote', 'remove', 'origin'], 'remove-origin');
      return verify(stage, 'checkout-policy', () => {
        verifyWorkspaceSource(preparation);
        verifyCheckout(instance, preparation.suite, []);
        const env = { ...childEnvironment(runPath), npm_config_registry: 'https://registry.npmjs.org/',
          npm_config_script_shell: '/bin/sh' };
        return { instance, workspace, env };
      });
    }

    type Snapshot = Awaited<ReturnType<typeof snapshot>>;
    async function npmStep(directory: Snapshot, args: readonly string[], format: Parameters<typeof runProcess>[6] = false,
      collect?: (chunk: string) => void, onTestPasses?: (passes: number) => void) {
      await yieldToSignals();
      const { workspace, env } = directory;
      return runProcess(process.execPath, [npm.executable, ...args], workspace,
        args === dgiCommands.build ? { ...env, NODE_ENV: 'production' } : env, timeout, abort.signal, format, collect,
        onTestPasses);
    }

    async function capture(directory: Snapshot, name: string, args: readonly string[], validate = (output: string) => output) {
      let output = '';
      let overflow = false;
      const outcome = await npmStep(directory, args, false, chunk => {
        if (output.length + chunk.length > jsonLimit) overflow = true;
        if (!overflow) output += chunk;
      });
      record('clu', name, outcome);
      return verify('clu', name + '-output', () => {
        if (overflow) throw new Blocked('integrity');
        return validate(output);
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
      const version = await capture(directory, 'npm-version', cluCommands.version, output => {
        const version = output.trim();
        if (!exactVersion(version) || version !== npm.version) throw new Blocked('integrity');
        return version;
      });
      record('clu', 'install', await npmStep(directory, installArgs));
      verify('clu', 'verify-install', () => {
        verifyCheckout(instance, clu.suite, install.roots);
        verifyDependencies(workspace, profile, install);
        verifyInstalledTool(workspace, 'vite', '');
      });
      const test = await npmStep(directory, cluCommands.test, profile.format, undefined,
        passes => { observations.clu.observedPasses = passes; });
      record('clu', 'test', test.status === 'PASS' && observations.clu.observedPasses === null ?
        { ...test, status: 'FAIL', failureCategory: 'missing-evidence', cliCode: 1 } : test);
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
        const approved = receiptFor(clu.source.sha, manifest.version, version, result.bytes);
        writeFileSync(join(run.runPath, approved.archive), result.bytes, { flag: 'wx', mode: 0o400 });
        receipt = approved;
        archive = result.bytes;
        return { ...result, receipt: approved };
      });
    }

    async function runFrontend(stage: 'baseline' | 'candidate', directory: Snapshot,
      plan: ReturnType<typeof planCandidateDelta>, producer?: Awaited<ReturnType<typeof produce>>) {
      const { instance, workspace, env } = directory;
      const { profile, install } = producer ? plan : plan.baseline;
      verify(stage, 'apply-dependencies', () => {
        if (producer) applyDgiCandidate(workspace, plan, producer.bytes);
        verifyDgiDependencies(instance, dgi.suite, plan, [], producer?.bytes);
      });
      record(stage, 'install', await npmStep(directory, installArgs));
      const outputs: string[] = [];
      const verifyTree = (name: string) => verify(stage, name, () => {
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
      function verifyInstall(end: boolean) {
        verify(stage, end ? 'dependency-integrity-after' : 'dependency-integrity-before', () => {
          for (const tool of dgiTools) verifyInstalledTool(workspace, tool, 'frontend');
          if (producer) {
            const installed = verifyInstalledPackage(workspace, plan, producer.archive);
            if (end) observations.candidate.installed = installed;
          } else {
            verifyDependencies(workspace, { ...profile, tool: 'node', toolWorkspace: '' }, install);
            const published = requirePublishedClu(workspace, plan);
            if (end) observations.baseline.published = published;
          }
        });
      }
      verifyTree('checkout-integrity-before');
      verifyInstall(false);
      if (producer) {
        try {
          const installed = await verifyInstalledExports(workspace, plan, async (args, cwd, collect) => {
            await yieldToSignals();
            record(stage, 'resolve-exports', await runProcess(process.execPath, args, cwd, env, timeout, abort.signal, false, collect));
          });
          verify(stage, 'candidate-identity', () => {
            observations.candidate.exports = { javascript: installed.javascript.slice(workspace.length + 1),
              declaration: installed.declaration.slice(workspace.length + 1), stylesheet: installed.stylesheet.slice(workspace.length + 1),
              react: installed.react.slice(workspace.length + 1), reactVersion: installed.reactVersion };
          });
        } catch (error) {
          if (error instanceof Stopped) throw error;
          throw new Stopped(stage, { name: 'candidate-identity', ...blocked('integrity') });
        }
      }
      for (const name of dgiChecks) {
        if (name === 'build') outputs.push('frontend/dist');
        if (name === 'test') {
          outputs.push('artifacts', 'reports');
          verify(stage, 'report-directory', () => mkdirSync(join(workspace, 'reports'), { mode: 0o700 }));
        }
        const start = Date.now();
        const phase = observations[stage];
        const commandDirectory = name === 'test' && producer ?
          { ...directory, env: { ...env, QEP_CLU_CANDIDATE_SRI: producer.receipt.integrity } } : directory;
        let outcome = await npmStep(commandDirectory, dgiCommands[name], name === 'test' ? 'dgi-frontend-allure' : false,
          undefined, passes => { phase.observedPasses = passes; });
        if (name === 'test' && (outcome.status === 'PASS' || ordinaryFailure(outcome))) {
          try {
            const tests = readFrontendTests(stage, instance, start, outcome);
            phase.tests = tests;
            if (outcome.status === 'PASS' && tests.counts.passed !== phase.observedPasses) {
              outcome = { ...outcome, status: 'FAIL', cliCode: 1, failureCategory: 'failed-evidence' };
            }
          }
          catch {
            if (outcome.status === 'PASS') outcome = { ...outcome, status: 'FAIL', cliCode: 1, failureCategory: 'missing-evidence' };
          }
        }
        record(stage, name, outcome, true);
        verifyTree(name + '-integrity');
      }
      verify(stage, 'clear-vite-caches', () => clearViteCaches(workspace, install.roots));
      verifyInstall(true);
    }

    const workDirectory = () => lstatSync(workPath, { bigint: true });
    const reservation = lstatSync(run.runPath, { bigint: true });
    mkdirSync(workPath, { mode: 0o700 });
    const scratch = workDirectory();
    try {
      const producer = await produce();
      const baseline = await snapshot('baseline', dgi);
      plan = verify('baseline', 'dependency-plan', () => {
        const plan = planCandidateDelta(baseline.workspace, producer.archive);
        locks = plan.files.find(file => file.path === lockFile)!;
        return plan;
      });
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
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      const { stage, step } = error;
      if (!observations[stage].steps.includes(step)) observations[stage].steps.push(step);
    }
    await yieldToSignals();
    const current = lstatSync(run.runPath, { bigint: true });
    if (current.dev !== reservation.dev || current.ino !== reservation.ino) throw new Error('Evaluation storage ownership changed.');
    if (cleanupSafe) {
      try {
        const owned = workDirectory();
        if (owned.dev !== scratch.dev || owned.ino !== scratch.ino) throw new Error('Evaluation workspace ownership changed.');
        rmSync(workPath, { recursive: true });
      } catch {
        cleanupSafe = false;
      }
    }
    for (const name of phases) observations[name].status = derivePhase(name, observations[name]);
    const inputs: RecordInputs = { schemaVersion: 1, evaluationId: run.runId, startedAt, endedAt: new Date().toISOString(),
      runtime: { node: process.version, npm: npm.version, qep: packageMetadata.version }, timeoutMs: timeout,
      commits: { clu: clu.source.sha, dgi: dgi.source.sha }, archive: receipt ?? null,
      locks: locks ? { originalSha256: sha256(locks.before), patchedSha256: sha256(locks.after) } : null, phases: observations,
      interruption: !cleanupSafe ? 'cleanup' : abort.signal.aborted ? abort.signal.reason : null };
    const evidence: ConsumerGateV1 = { ...inputs, decision: deriveDecision(inputs) };
    const summary = summarizeConsumer(evidence, { clu: clu.source.path, dgi: dgi.source.path }, plan);
    const manifestSha256 = sealConsumerEvidence(run.runPath, evidence,
      { summary: Buffer.from(JSON.stringify(summary, null, 2) + '\n'), archive, locks });
    const { exitCode } = summary;
    const message = JSON.stringify({ summaryPath, manifestSha256, ...summary }, null, 2);
    return exitCode === 0 ? { exitCode: 0, stdout: message } : { exitCode, stderr: message };
  } finally {
    try { release(cleanupSafe); } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  }
}

export async function consumerCli(args: readonly string[]) {
  if (args[0] === 'verify') return verifyConsumerCli(args.slice(1));
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
