import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToSignals } from 'node:timers/promises';
import { sealCluReport } from './clu-junit.js';
import { installedNpm, parseSuiteArgs, renderPlan } from './plan.js';
import { checkInstall, verifyDependencies } from './install-policy.js';
import { Blocked, cancellation, runProcess, type Outcome } from './run-process.js';
import { lockRuntime, writeSummary } from './run-control.js';
import { childEnvironment, inspectSuite, verifyCheckout } from './run-policy.js';
import { checkoutWorkspace, prepareWorkspace, reserveWorkspace, validateWorkspacePaths } from './workspace.js';

export async function runSuiteCli(args: readonly string[]) {
  const request = parseSuiteArgs(args, true);
  if (!request.execute) {
    if (request.installDeps) throw new Error('--install-deps requires --execute.');
    validateWorkspacePaths(request.source);
    return { exitCode: 0, stdout: renderPlan(request) };
  }
  if (process.platform !== 'linux') throw new Error('Execution requires Linux process groups and procfs.');
  const preparation = prepareWorkspace(request);
  const release = lockRuntime(preparation.runs);
  let cleanupVerified = true;
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const run = reserveWorkspace(preparation);
    const start = new Date();
    const clock = performance.now();
    let phase: 'checkout' | 'install' | 'test' = 'checkout';
    let requestedReport = false;
    async function execute(): Promise<Outcome> {
      checkoutWorkspace(run, preparation);
      const suite = preparation.suite;
      verifyCheckout(run, suite);
      const profile = inspectSuite(run, suite);
      const env = childEnvironment(run.runPath);
      const { executable } = installedNpm();
      let installation: ReturnType<typeof checkInstall> | undefined;
      if (profile.needsDeps || request.installDeps) {
        phase = 'install';
        if (!request.installDeps) throw new Blocked('dependencies-required');
        installation = checkInstall(run.workspace, profile);
        await yieldToSignals();
        const install = await runProcess(executable, ['ci', '--ignore-scripts', '--include=dev'], run.workspace,
          env, request.timeoutMs, controller.signal, false);
        if (install.status !== 'PASS') return install;
      }
      phase = 'test';
      await yieldToSignals();
      verifyCheckout(run, suite, installation?.roots);
      if (installation) verifyDependencies(run.workspace, profile, installation);
      if (profile.workspaceManifests.size) mkdirSync(join(run.workspace, 'reports'), { mode: 0o700 });
      if (request.cluJUnit) {
        mkdirSync(join(run.workspace, 'artifacts'), { mode: 0o700 });
        mkdirSync(join(run.workspace, 'artifacts', 'qep'), { mode: 0o700 });
        env.QEP_REPORTING = '1';
        requestedReport = true;
      }
      return runProcess(executable, suite.command.args, run.workspace, env, request.timeoutMs, controller.signal, profile.format);
    }
    let outcome: Outcome;
    try { outcome = await execute(); } catch (error) {
      outcome = { status: 'BLOCKED', exitCode: null, cliCode: 2,
        failureCategory: error instanceof Blocked ? error.category : 'integrity' };
    }
    cleanupVerified = outcome.failureCategory !== 'cleanup';
    await yieldToSignals();
    if (controller.signal.aborted && cleanupVerified && outcome.status !== 'TIMEOUT') {
      outcome = cancellation(controller.signal.reason, outcome.exitCode);
    }
    const { status, exitCode, failureCategory } = outcome;
    const summary = { runId: run.runId, suiteId: run.suiteId, sourceRepository: run.source.repository,
      commitSha: run.source.sha, runtimeVersion: process.version, startedAt: start.toISOString(),
      endedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - clock),
      phase, status, exitCode, failureCategory };
    const summaryBytes = Buffer.from(JSON.stringify(summary, null, 2) + '\n');
    let reportMissing = false;
    if (requestedReport && cleanupVerified) {
      try { sealCluReport(run.runId, summaryBytes); } catch { reportMissing = true; }
    }
    const path = join(run.runPath, 'summary.json');
    try {
      writeSummary(path, summaryBytes);
    } catch { throw new Error('Unable to publish summary for run ' + run.runId + '.'); }
    if (reportMissing && outcome.cliCode === 0) throw new Error('Unable to seal CLU JUnit for run ' + run.runId + '.');
    const hint = failureCategory === 'lifecycle-review' ? ' Request a separately reviewed lifecycle-script exception.' :
      failureCategory === 'dependencies-required' && !request.installDeps ? ' Supply --install-deps to permit npm ci.' : '';
    const message = request.json ? JSON.stringify(summary, null, 2) :
      `${status} ${run.suiteId}${failureCategory ? ' (' + failureCategory + ')' : ''}. Summary: ${path}.${hint}`;
    return outcome.cliCode === 0 ? { exitCode: 0, stdout: message } : { exitCode: outcome.cliCode, stderr: message };
  } finally {
    try { release(cleanupVerified); } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  }
}
