import { isDeepStrictEqual } from 'node:util';
import { archiveLimit, exactVersion, cluPackage } from './clu-candidate-archive.js';
import { buildCommand, unitCommand, type receiptFor } from './clu-candidate.js';
import { archiveFile, cluLocation, lockLimit, publishedCluIntegrity } from './dgi-candidate-lock.js';
import type { verifyInstalledPackage } from './dgi-candidate.js';
import { isRecord } from './metadata.js';
import { limitsV1, sha256, validRunId, type CaseRecordV1, type ResultContractV1 } from './result-contract-v1.js';
import type { Outcome } from './run-process.js';
import { parseStrictJson } from './strict-json.js';

export const recordName = 'consumer-gate-v1.json';
export const manifestName = 'manifest-v1.json';
export const manifestLimit = 4096;
export const summaryName = 'summary.json';
export const archiveName = 'candidate.tgz';
export const originalLockName = 'dgi-original-lock.json';
export const patchedLockName = 'dgi-patched-lock.json';
export const fileLimits = { [recordName]: 4 * 1024 * 1024, [summaryName]: 256 * 1024, [archiveName]: archiveLimit,
  [originalLockName]: lockLimit, [patchedLockName]: lockLimit };
export type EvidenceFile = keyof typeof fileLimits;
export const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const sha512Pattern = /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/;
export const phases = ['clu', 'baseline', 'candidate'] as const;
export type PhaseName = typeof phases[number];
type Status = 'PASS' | 'FAIL' | 'BLOCKED';
export type GateStep = { name: string } & Outcome;
type TestCase = Pick<CaseRecordV1, 'caseId' | 'status'>;
export type FrontendTests = { counts: ResultContractV1['counts']; casesSha256: string; cases: TestCase[] };
type PackageEntry = { version: string; resolved: string; integrity: string };
export type Installed = ReturnType<typeof verifyInstalledPackage>;
export type Exports = { javascript: string; declaration: string; stylesheet: string; react: string; reactVersion: string };
export type Phase = { status: Status; checkoutSha: string | null; steps: GateStep[]; observedPasses: number | null };
export type RecordInputs = {
  schemaVersion: 1;
  evaluationId: string;
  startedAt: string;
  endedAt: string;
  runtime: { node: string; npm: string; qep: string };
  timeoutMs: number;
  commits: { clu: string; dgi: string };
  archive: ReturnType<typeof receiptFor> | null;
  locks: { originalSha256: string; patchedSha256: string } | null;
  phases: {
    clu: Phase;
    baseline: Phase & { tests: FrontendTests | null; published: PackageEntry | null };
    candidate: Phase & { tests: FrontendTests | null; installed: Installed | null; exports: Exports | null };
  };
  interruption: 'SIGINT' | 'SIGTERM' | 'cleanup' | null;
};
export type ConsumerGateV1 = RecordInputs & {
  decision: ReturnType<typeof deriveDecision>;
};
export type ManifestFile = { name: EvidenceFile; bytes: number; sha256: string };
export type ManifestV1 = {
  schemaVersion: 1;
  evaluationId: string;
  commits: RecordInputs['commits'];
  files: ManifestFile[];
};

const checkout = ['prepare-checkout', 'clone', 'checkout', 'checkout-provenance', 'remove-origin', 'checkout-policy'];
const frontend = ['typecheck', 'typecheck-integrity', 'build', 'build-integrity', 'report-directory', 'test',
  'test-integrity', 'clear-vite-caches', 'dependency-integrity-after'];
const sequence = {
  clu: [...checkout, 'install-policy', 'npm-version', 'npm-version-output', 'install', 'verify-install', 'test',
    'verify-test', 'build', 'verify-build', 'pack', 'pack-output', 'verify-archive'],
  baseline: [...checkout, 'dependency-plan', 'apply-dependencies', 'install', 'checkout-integrity-before',
    'dependency-integrity-before', ...frontend],
  candidate: [...checkout, 'apply-dependencies', 'install', 'checkout-integrity-before', 'dependency-integrity-before',
    'resolve-exports', 'candidate-identity', ...frontend, 'source-provenance'],
};
const childSteps = new Set(['clone', 'checkout', 'remove-origin', 'npm-version', 'install', 'test', 'build', 'pack',
  'typecheck', 'resolve-exports']);
const frontCommands = new Set(['typecheck', 'build', 'test']);
const policyFailures = new Set(['dependencies-required', 'unsupported-install', 'lifecycle-review', 'unsupported-profile', 'integrity']);

export const passed = (phase: Phase, name: string) => phase.steps.some(step => step.name === name && step.status === 'PASS');
export const ordinaryFailure = (step: Outcome) => step.status === 'FAIL' &&
  (step.failureCategory === 'exit-nonzero' || step.failureCategory === 'failed-evidence' || step.failureCategory === 'missing-evidence');
export const canContinue = (phase: PhaseName, step: GateStep) => step.status === 'PASS' ||
  (phase !== 'clu' && frontCommands.has(step.name) && ordinaryFailure(step));

export function evidenceInventory(hasArchive: boolean, hasLocks: boolean): EvidenceFile[] {
  return [recordName, summaryName, ...(hasArchive ? [archiveName] as const : []),
    ...(hasLocks ? [originalLockName, patchedLockName] as const : [])];
}

export function derivePhase(name: PhaseName, phase: Phase): Status {
  if (name === 'clu' && phase.steps.some(step => (step.name === 'test' || step.name === 'build') &&
      step.failureCategory === 'exit-nonzero')) return 'FAIL';
  if (phase.steps.length !== sequence[name].length ||
      phase.steps.some(step => step.status !== 'PASS' &&
        !(name !== 'clu' && frontCommands.has(step.name) && step.failureCategory === 'exit-nonzero'))) return 'BLOCKED';
  return phase.steps.every(step => step.status === 'PASS') ? 'PASS' : 'FAIL';
}

export function deriveDecision(record: RecordInputs) {
  const { baseline, candidate } = record.phases;
  const steps = phases.flatMap(name => record.phases[name].steps);
  const firstNonzero = steps.find(step => step.exitCode !== null && step.exitCode !== 0)?.exitCode;
  const halted = steps.find(step => step.status === 'TIMEOUT' || step.status === 'CANCELLED');
  function blocked(reason: string, cliExitCode: number) { return { status: 'BLOCKED' as const, reason, cliExitCode }; }
  if (record.interruption === 'cleanup' || steps.some(step => step.failureCategory === 'cleanup')) return blocked('cleanup', 2);
  if (halted?.status === 'TIMEOUT') return blocked('timeout', halted.cliCode);
  if (record.interruption) return blocked('cancelled', record.interruption === 'SIGINT' ? 130 : 143);
  if (halted) return blocked('cancelled', halted.cliCode);
  for (const name of phases) {
    const phase = record.phases[name];
    if (phase.status === 'BLOCKED' || (name !== 'candidate' && phase.status !== 'PASS')) {
      const failure = phase.steps.find(step => !canContinue(name, step)) ?? phase.steps.find(step => step.status !== 'PASS');
      return blocked((name === 'clu' ? 'producer' : name) + '-' + (failure?.failureCategory ?? 'not-run'),
        firstNonzero ?? failure?.cliCode ?? 2);
    }
  }
  if (candidate.status === 'FAIL' || baseline.tests?.casesSha256 !== candidate.tests?.casesSha256) {
    return { status: 'FAIL' as const, reason: 'candidate-compatibility-regression', cliExitCode: firstNonzero ?? 1 };
  }
  return { status: 'PASS' as const, reason: null, cliExitCode: 0 };
}

function check(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error('Invalid consumer gate evidence (' + field + ').');
}

function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  const keys = names.split(' ');
  check(isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), names);
}

const matches = (value: unknown, pattern: RegExp, limit: number) =>
  typeof value === 'string' && value.length <= limit && pattern.test(value);
const digest = (value: unknown) => matches(value, digestPattern, 64);
const sha = (value: unknown) => matches(value, shaPattern, 40);
const integer = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const version = (value: unknown) => typeof value === 'string' && value.length <= 128 && exactVersion(value);
const isoDate = (value: unknown) => typeof value === 'string' && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function commits(value: unknown) {
  fields(value, 'clu dgi');
  check(sha(value.clu) && sha(value.dgi), 'commits');
}

function validateArchive(value: unknown, record: RecordInputs) {
  fields(value, 'schemaVersion producerSha name version npmVersion archive size sha256 integrity buildCommand unitCommand');
  check(value.schemaVersion === 1 && value.producerSha === record.commits.clu && value.name === cluPackage &&
    version(value.version) && value.npmVersion === record.runtime.npm && value.archive === archiveName &&
    integer(value.size, 1, archiveLimit) && digest(value.sha256) && matches(value.integrity, sha512Pattern, 95) &&
    value.buildCommand === buildCommand && value.unitCommand === unitCommand, 'archive receipt');
}

function validateStep(value: unknown, name: string) {
  fields(value, 'name status exitCode cliCode failureCategory');
  const { status, exitCode, cliCode, failureCategory: failure } = value;
  const child = childSteps.has(name);
  check(value.name === name && (exitCode === null || (child && integer(exitCode, 0, 255))), 'step');
  const nonzero = integer(exitCode, 1, 255) && cliCode === exitCode;
  switch (status) {
    case 'PASS': check(failure === null && cliCode === 0 && exitCode === (child ? 0 : null), 'passing step'); break;
    case 'FAIL': check(child && ((failure === (name === 'install' ? 'install-failed' : 'exit-nonzero') && nonzero) ||
      (failure === 'signal' && exitCode === null && integer(cliCode, 129, 192)) ||
      (failure === 'background-process' && (nonzero || ((exitCode === 0 || exitCode === null) && cliCode === 1))) ||
      (name === 'test' && (failure === 'missing-evidence' || failure === 'failed-evidence') && exitCode === 0 && cliCode === 1)), 'failed step'); break;
    case 'BLOCKED': check(cliCode === 2 && ((child && (failure === 'cleanup' || (failure === 'startup' && exitCode === null))) ||
      (!child && typeof failure === 'string' && policyFailures.has(failure))), 'blocked step'); break;
    case 'TIMEOUT': check(child && failure === 'timeout' && cliCode === 124, 'timeout step'); break;
    case 'CANCELLED': check(child && failure === 'cancelled' && (cliCode === 130 || cliCode === 143), 'cancelled step'); break;
    default: check(false, 'step status');
  }
}

function validateTests(value: unknown) {
  fields(value, 'counts casesSha256 cases');
  check(Array.isArray(value.cases) && integer(value.cases.length, 1, limitsV1.cases), 'case count');
  const counts = { total: value.cases.length, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
  const statuses = ['passed', 'failed', 'broken', 'skipped', 'unknown'] as const;
  let last = '';
  const cases = value.cases.map((item: unknown) => {
    fields(item, 'caseId status');
    const status = statuses.find(status => status === item.status);
    check(typeof item.caseId === 'string' && matches(item.caseId, /^dgi-frontend-unit:[a-f0-9]{64}$/, 82) &&
      item.caseId > last && status, 'case');
    last = item.caseId;
    counts[status]++;
    return { caseId: item.caseId, status };
  });
  check(isDeepStrictEqual(counts, value.counts) && value.casesSha256 === sha256(JSON.stringify(cases)), 'test counts or digest');
}

function validateEntry(value: unknown, installed: boolean) {
  fields(value, 'version resolved integrity' + (installed ? ' membersSha256' : ''));
  check(version(value.version), 'CLU package version');
  const resolved = installed ? 'file:' + archiveFile :
    'https://registry.npmjs.org/' + cluPackage + '/-/clu-ui-' + value.version + '.tgz';
  check(value.resolved === resolved &&
    matches(value.integrity, installed ? sha512Pattern : publishedCluIntegrity, 95) &&
    (!installed || digest(value.membersSha256)), 'installed or published CLU entry');
}

function validateExports(value: unknown) {
  fields(value, 'javascript declaration stylesheet react reactVersion');
  check(value.javascript === cluLocation + '/dist/index.js' && value.declaration === cluLocation + '/dist/index.d.ts' &&
    value.stylesheet === cluLocation + '/dist/styles.css' &&
    matches(value.react, /^node_modules\/react\/(?:[\w.-]+\/)*[\w.-]+$/, 256) &&
    !(value.react as string).split('/').some(part => part === '..' || part === '.') && version(value.reactVersion), 'candidate exports');
}

function validatePhase(value: unknown, name: PhaseName, expectedCommit: string) {
  const extra = { clu: '', baseline: ' tests published', candidate: ' tests installed exports' }[name];
  fields(value, 'status checkoutSha steps observedPasses' + extra);
  const expected = sequence[name];
  check(Array.isArray(value.steps) && value.steps.length <= expected.length, 'phase steps');
  for (const [index, step] of value.steps.entries()) {
    validateStep(step, expected[index]!);
    check(index === value.steps.length - 1 || canContinue(name, step), 'steps after a terminal outcome');
  }
  const phase = value as unknown as Phase;
  check(value.checkoutSha === (passed(phase, 'checkout-provenance') ? expectedCommit : null), 'checkout commit');
  check(value.status === derivePhase(name, phase), 'phase status');
  const test = phase.steps.find(step => step.name === 'test');
  check(value.observedPasses === null || (test && (test.status === 'PASS' || ordinaryFailure(test)) &&
    integer(value.observedPasses, 1, Number.MAX_SAFE_INTEGER)), 'observed test count');
  if (test?.status === 'PASS') check(value.observedPasses !== null, 'missing observed test count');
  if (name === 'clu') return;
  if (value.tests !== null) {
    check(test && (test.status === 'PASS' || ordinaryFailure(test)), 'unexpected test evidence');
    validateTests(value.tests);
  }
  const tests = value.tests as FrontendTests | null;
  if (test?.status === 'PASS') check(tests && tests.counts.total === tests.counts.passed &&
    tests.counts.passed === value.observedPasses, 'passing frontend tests');
  if (test?.failureCategory === 'missing-evidence' && tests) {
    check(value.observedPasses === null, 'missing test evidence');
  }
  if (name === 'baseline') {
    check((value.published !== null) === passed(phase, 'dependency-integrity-after'), 'published CLU observation');
    if (value.published !== null) validateEntry(value.published, false);
  } else {
    check((value.installed !== null) === passed(phase, 'dependency-integrity-after') &&
      (value.exports !== null) === passed(phase, 'candidate-identity'), 'installed CLU observations');
    if (value.installed !== null) validateEntry(value.installed, true);
    if (value.exports !== null) validateExports(value.exports);
  }
}

export function parseConsumerGateV1(bytes: Buffer): ConsumerGateV1 {
  const value = parseStrictJson(bytes, fileLimits[recordName], 8, 24);
  fields(value, 'schemaVersion evaluationId startedAt endedAt runtime timeoutMs commits archive locks phases interruption decision');
  check(value.schemaVersion === 1, 'record version');
  validRunId(value.evaluationId);
  check(isoDate(value.startedAt) && isoDate(value.endedAt) && String(value.startedAt) <= String(value.endedAt), 'timestamps');
  fields(value.runtime, 'node npm qep');
  check(typeof value.runtime.node === 'string' && value.runtime.node.startsWith('v') && version(value.runtime.node.slice(1)) &&
    version(value.runtime.npm) && version(value.runtime.qep), 'runtime versions');
  check(integer(value.timeoutMs, 1, 1_800_000), 'timeout');
  commits(value.commits);
  fields(value.phases, 'clu baseline candidate');
  const record = value as unknown as ConsumerGateV1;
  const { clu, baseline, candidate } = record.phases;
  for (const name of phases) validatePhase(record.phases[name], name, record.commits[name === 'clu' ? 'clu' : 'dgi']);
  check((record.archive !== null) === passed(clu, 'verify-archive') && (!baseline.steps.length || clu.status === 'PASS') &&
    (!candidate.steps.length || passed(baseline, 'dependency-integrity-after')), 'phase ordering or archive');
  if (record.archive !== null) validateArchive(record.archive, record);
  check((record.locks !== null) === passed(baseline, 'dependency-plan'), 'lockfiles');
  if (record.locks !== null) {
    fields(record.locks, 'originalSha256 patchedSha256');
    check(digest(record.locks.originalSha256) && digest(record.locks.patchedSha256) &&
      record.locks.originalSha256 !== record.locks.patchedSha256, 'lock digests');
  }
  check([null, 'SIGINT', 'SIGTERM', 'cleanup'].some(item => item === value.interruption), 'interruption');
  const lastPhase = [...phases].reverse().find(name => record.phases[name].steps.length);
  check(lastPhase, 'empty evaluation');
  const lastStep = record.phases[lastPhase].steps.at(-1)!;
  check(lastStep.failureCategory !== 'cleanup' || record.interruption === 'cleanup', 'unsafe cleanup');
  if (lastStep.status === 'CANCELLED' && record.interruption !== 'cleanup') {
    check(record.interruption === (lastStep.cliCode === 130 ? 'SIGINT' : 'SIGTERM'), 'cancellation signal');
  }
  check(!canContinue(lastPhase, lastStep) || passed(candidate, 'source-provenance'), 'evaluation completion');
  for (const name of phases) {
    const steps = record.phases[name].steps;
    check(!steps.length || steps.length === sequence[name].length || !canContinue(name, steps.at(-1)!), 'incomplete phase');
  }
  check(isDeepStrictEqual(value.decision, deriveDecision(record)), 'overall decision');
  return record;
}

export function parseManifestV1(bytes: Buffer): ManifestV1 {
  const value = parseStrictJson(bytes, manifestLimit, 4, 6);
  fields(value, 'schemaVersion evaluationId commits files');
  check(value.schemaVersion === 1, 'manifest version');
  validRunId(value.evaluationId);
  commits(value.commits);
  check(Array.isArray(value.files) && [2, 3, 5].includes(value.files.length), 'manifest inventory');
  const inventory = evidenceInventory(value.files.length >= 3, value.files.length === 5);
  for (const [index, file] of value.files.entries()) {
    fields(file, 'name bytes sha256');
    const name = inventory[index]!;
    check(file.name === name && integer(file.bytes, 1, fileLimits[name]) &&
      digest(file.sha256), 'manifest entry');
  }
  return value as unknown as ManifestV1;
}
