import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TestEvidence } from './test-evidence.js';
import type { EvidenceFormat } from './test-evidence.js';

export type Outcome = {
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT';
  exitCode: number | null;
  cliCode: number;
  failureCategory: 'startup' | 'exit-nonzero' | 'signal' | 'missing-evidence' | 'timeout' | 'cancelled' |
    'failed-evidence' | 'background-process' | 'cleanup' | 'install-failed' | 'dependencies-required' | 'unsupported-install' |
    'lifecycle-review' | 'unsupported-profile' | 'integrity' | null;
};

export class Blocked extends Error {
  constructor(readonly category: NonNullable<Outcome['failureCategory']>) { super(category); }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function groupAlive(pid: number) {
  if (!signalGroup(pid, 0)) return false;
  // In containers PID 1 may leave orphan zombies indefinitely. They cannot
  // execute or hold ports. Inspect process state/group only, never cmdline/env.
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync('/proc/' + entry + '/stat', 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(group) === pid && state !== 'Z' && state !== 'X') return true;
  }
  return false;
}

export function cancellation(signal: NodeJS.Signals, exitCode: number | null): Outcome {
  return { status: 'CANCELLED', failureCategory: 'cancelled', exitCode, cliCode: 128 + constants.signals[signal] };
}

export async function runProcess(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
  timeoutMs: number, abort: AbortSignal, format: EvidenceFormat | false): Promise<Outcome> {
  if (abort.aborted) return cancellation(abort.reason, null);
  // A private POSIX process group lets us signal npm AND its descendants.
  // The child remains referenced, with pipes attached, and is always awaited.
  let child;
  try {
    child = spawn(executable, args, { cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return { status: 'BLOCKED', failureCategory: 'startup', exitCode: null, cliCode: 2 };
  }
  const streams = [child.stdout, child.stderr] as const;
  function readEvidence(stream: (typeof streams)[number]) {
    const reader = new TestEvidence(format || 'standard');
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { if (format) reader.add(chunk); });
    return reader;
  }
  const stdout = readEvidence(child.stdout);
  const stderr = readEvidence(child.stderr);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  type StopReason = 'cancelled' | 'timeout' | 'background-process';
  let reason: StopReason | undefined;
  let started = false;
  let unsafe = false;
  let wake!: () => void;
  const endedOrStopped = new Promise<void>(resolve => { wake = resolve; });
  function stop(why: StopReason) {
    reason ??= why;
    wake();
  }
  child.once('spawn', () => { started = true; });
  child.once('error', wake);
  child.once('exit', wake);
  const onAbort = () => stop('cancelled');
  abort.addEventListener('abort', onAbort);
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  try {
    await endedOrStopped;
    clearTimeout(timer);
    const pid = child.pid;
    if (pid && groupAlive(pid)) {
      reason ??= 'background-process';
      signalGroup(pid, reason === 'cancelled' ? abort.reason : 'SIGTERM');
      const graceEnd = performance.now() + 500;
      while (groupAlive(pid) && performance.now() < graceEnd) await delay(25);
      if (groupAlive(pid)) {
        signalGroup(pid, 'SIGKILL');
        const killEnd = performance.now() + 2000;
        while (groupAlive(pid) && performance.now() < killEnd) await delay(25);
        unsafe = groupAlive(pid);
      }
    }
    // An escaped writer must not hold the CLI open on a pipe indefinitely.
    let drained = false;
    let drainTimer: NodeJS.Timeout | undefined;
    await Promise.race([closed.then(() => { drained = true; }),
      new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 500); })]);
    clearTimeout(drainTimer);
    const exitCode = started ? child.exitCode : null;
    if (unsafe || !drained) return { status: 'BLOCKED', failureCategory: 'cleanup', exitCode, cliCode: 2 };
    if (reason === 'cancelled') return cancellation(abort.reason, exitCode);
    if (reason === 'timeout') return { status: 'TIMEOUT', failureCategory: 'timeout', exitCode, cliCode: 124 };
    if (reason) return { status: 'FAIL', failureCategory: reason, exitCode, cliCode: exitCode || 1 };
    if (!started) return { status: 'BLOCKED', failureCategory: 'startup', exitCode: null, cliCode: 2 };
    if (child.signalCode) return { status: 'FAIL', failureCategory: 'signal', exitCode,
      cliCode: 128 + constants.signals[child.signalCode] };
    if (exitCode !== 0) return { status: 'FAIL', failureCategory: format ? 'exit-nonzero' : 'install-failed',
      exitCode, cliCode: exitCode ?? 1 };
    if (format) {
      const result = stdout.result(stderr);
      if (result === 'failed') return { status: 'FAIL', failureCategory: 'failed-evidence', exitCode, cliCode: 1 };
      if (result === 'missing') return { status: 'FAIL', failureCategory: 'missing-evidence', exitCode, cliCode: 1 };
    }
    return { status: 'PASS', failureCategory: null, exitCode, cliCode: 0 };
  } catch {
    // Fail closed if process-group inspection itself fails.
    try { if (child.pid) signalGroup(child.pid, 'SIGKILL'); } catch { /* retain the runtime lock */ }
    return { status: 'BLOCKED', failureCategory: 'cleanup', exitCode: child.exitCode, cliCode: 2 };
  } finally {
    clearTimeout(timer);
    abort.removeEventListener('abort', onAbort);
    for (const stream of streams) stream.destroy();
  }
}
