import { fstatSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { memberInventorySha256, verifyCandidateArchive } from './clu-candidate-archive.js';
import { receiptFor } from './clu-candidate.js';
import { archiveName, canContinue, evidenceInventory, fileLimits, manifestLimit, manifestName, originalLockName, passed,
  parseConsumerGateV1, parseManifestV1, patchedLockName, phases, recordName, shaPattern, summaryName,
  type ConsumerGateV1, type EvidenceFile, type ManifestV1 } from './consumer-gate-v1.js';
import { replayDgiCandidateLock } from './dgi-candidate-lock.js';
import { isRecord } from './metadata.js';
import { sha256, validRunId } from './result-contract-v1.js';
import { writeSummary } from './run-control.js';
import { entries, requirePrivateDirectory, withLocalStorage } from './run-storage.js';
import { findSuite, reviewedConsumerDgiShas } from './suite-catalog.js';
import { parseStrictJson } from './strict-json.js';

export const consumerStorage = 'consumer-gate';
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
type PackagePlan = Pick<ReturnType<typeof replayDgiCandidateLock>, 'published' | 'candidateEntry' | 'reactVersion'>;

export function summarizeConsumer(record: ConsumerGateV1, paths: { clu: string; dgi: string }, plan?: PackagePlan) {
  const { clu, baseline, candidate } = record.phases;
  const { status: verdict, reason, cliExitCode: exitCode } = record.decision;
  let status: string = verdict;
  if (verdict === 'FAIL') status = 'REGRESSION';
  if (reason === 'timeout') status = 'TIMEOUT';
  if (reason === 'cancelled') status = 'CANCELLED';
  if (reason?.startsWith('producer-') && clu.steps.some(step => step.status === 'FAIL')) status = 'PRODUCER_FAILED';
  if (reason?.startsWith('baseline-') && baseline.steps.some(step => step.status === 'FAIL')) status = 'BASELINE_FAILED';
  const stages = Object.fromEntries(phases.map(name => {
    const phase = record.phases[name];
    const tests = 'tests' in phase ? phase.tests : null;
    const hasPlan = name === 'baseline' || (name === 'candidate' && candidate.steps.some(step => step.name === 'apply-dependencies'));
    const dependencies = hasPlan && record.locks && plan ? {
      lockSha256: name === 'candidate' ? record.locks.patchedSha256 : record.locks.originalSha256,
      clu: name === 'candidate' ? plan.candidateEntry : plan.published,
      reactVersion: plan.reactVersion,
      ...(name === 'candidate' && candidate.exports ? { installed: candidate.exports } : {}),
      verified: passed(phase, 'dependency-integrity-after'),
    } : null;
    return [name, { steps: phase.steps.filter(step => step.exitCode !== null || step.status !== 'PASS'),
      ...(tests ? { tests: { counts: tests.counts, casesSha256: tests.casesSha256 } } : {}),
      ...(dependencies ? { dependencies } : {}) }];
  }));
  const lastPhase = [...phases].reverse().find(name => record.phases[name].steps.length);
  const lastStep = lastPhase && record.phases[lastPhase].steps.at(-1)!;
  return {
    schemaVersion: 1, evaluationId: record.evaluationId, startedAt: record.startedAt, endedAt: record.endedAt,
    node: record.runtime.node, npm: record.runtime.npm, timeoutMs: record.timeoutMs,
    sources: {
      clu: { repository: findSuite('clu-unit')!.repository, path: paths.clu, sha: record.commits.clu },
      dgi: { repository: findSuite('dgi-frontend-unit')!.repository, path: paths.dgi, sha: record.commits.dgi },
    },
    ...(record.archive ? { producer: record.archive } : {}), stages,
    ...(lastPhase && lastStep && !canContinue(lastPhase, lastStep) ? { stopped: { stage: lastPhase, step: lastStep } } : {}),
    status, reason, exitCode, decision: record.decision,
  };
}

export function sealConsumerEvidence(path: string, record: ConsumerGateV1, collected: {
  summary: Buffer; archive?: Buffer; locks?: { before: Buffer; after: Buffer };
}) {
  const files = { [recordName]: json(record), [summaryName]: collected.summary, [archiveName]: collected.archive,
    [originalLockName]: collected.locks?.before, [patchedLockName]: collected.locks?.after };
  parseConsumerGateV1(files[recordName]);
  const manifest: ManifestV1 = { schemaVersion: 1, evaluationId: record.evaluationId, commits: record.commits,
    files: evidenceInventory(Boolean(record.archive), Boolean(record.locks)).map(name => {
      const bytes = files[name];
      if (!bytes?.length || bytes.length > fileLimits[name]) throw new Error('Invalid consumer evidence file size.');
      return { name, bytes: bytes.length, sha256: sha256(bytes) };
    }) };
  for (const { name } of manifest.files) {
    // The archive was reserved and written as soon as the producer verified it.
    if (name !== archiveName) writeSummary(join(path, name), files[name]!);
  }
  // Exclusive publication of the manifest is the completion marker.
  const bytes = json(manifest);
  writeSummary(join(path, manifestName), bytes);
  return sha256(bytes);
}

function verifyPackages(record: ConsumerGateV1, files: Map<EvidenceFile, Buffer>) {
  if (!record.archive) return;
  const bytes = files.get(archiveName)!;
  const candidate = verifyCandidateArchive(bytes);
  const { version } = candidate.manifest;
  if (!isDeepStrictEqual(record.archive, receiptFor(record.commits.clu, version, record.runtime.npm, bytes))) {
    throw new Error('Invalid CLU archive receipt or producer commit.');
  }
  if (!record.locks) return;
  const before = files.get(originalLockName)!;
  const after = files.get(patchedLockName)!;
  const replay = replayDgiCandidateLock(before, candidate);
  if (record.locks.originalSha256 !== sha256(before) || record.locks.patchedSha256 !== sha256(after) ||
      !after.equals(replay.patched)) throw new Error('Invalid DGI original or patched lockfile.');
  const { baseline, candidate: phase } = record.phases;
  if (baseline.published && !isDeepStrictEqual(baseline.published, replay.published)) {
    throw new Error('Published CLU observation differs from the original lockfile.');
  }
  if (phase.exports && phase.exports.reactVersion !== replay.reactVersion) throw new Error('Invalid installed React version.');
  if (phase.installed) {
    const { resolved, integrity } = replay.candidateEntry;
    const expected = { version, resolved, integrity, membersSha256: memberInventorySha256(candidate.members) };
    if (!isDeepStrictEqual(phase.installed, expected)) throw new Error('Installed CLU observation differs from the verified archive.');
  }
  return replay;
}

function verifySummary(record: ConsumerGateV1, bytes: Buffer, plan?: PackagePlan) {
  const value = parseStrictJson(bytes, fileLimits[summaryName], 64, 4096);
  const sources = isRecord(value) ? value.sources : undefined;
  const paths = isRecord(sources) && isRecord(sources.clu) && isRecord(sources.dgi) ?
    { clu: sources.clu.path, dgi: sources.dgi.path } : undefined;
  const sourcePath = (path: unknown): path is string =>
    typeof path === 'string' && path.startsWith('/') && path.length <= 4096 && !path.includes('\0');
  if (!paths || !sourcePath(paths.clu) || !sourcePath(paths.dgi) ||
      !isDeepStrictEqual(value, summarizeConsumer(record, { clu: paths.clu, dgi: paths.dgi }, plan))) {
    throw new Error('Consumer run summary differs from the verified record.');
  }
}

export function verifyConsumerEvidence(evaluationId: string, expected: { clu?: string; dgi?: string; manifestSha256?: string } = {}) {
  validRunId(evaluationId);
  return withLocalStorage(local => {
    const gate = local.child(local.local, consumerStorage, true);
    requirePrivateDirectory(gate);
    return local.inspectChild(gate, evaluationId, fd => {
      const before = fstatSync(fd, { bigint: true });
      const bytes = local.file(fd, manifestName, manifestLimit);
      const manifest = parseManifestV1(bytes);
      const manifestSha256 = sha256(bytes);
      if (manifest.evaluationId !== evaluationId || !reviewedConsumerDgiShas.includes(manifest.commits.dgi) ||
          (expected.clu !== undefined && expected.clu !== manifest.commits.clu) ||
          (expected.dgi !== undefined && expected.dgi !== manifest.commits.dgi) ||
          (expected.manifestSha256 !== undefined && expected.manifestSha256 !== manifestSha256)) {
        throw new Error('Consumer evaluation ID, commit or manifest digest mismatch.');
      }
      const files = new Map<EvidenceFile, Buffer>();
      for (const { name, bytes: size, sha256: digest } of manifest.files) {
        const content = local.file(fd, name, fileLimits[name]);
        if (content.length !== size || sha256(content) !== digest) throw new Error('Consumer evidence digest mismatch.');
        files.set(name, content);
      }
      const record = parseConsumerGateV1(files.get(recordName)!);
      const expectedFiles = evidenceInventory(Boolean(record.archive), Boolean(record.locks));
      const dir = entries(fd, 7);
      if (record.decision.reason === 'cleanup' && dir.delete('work')) local.inspectChild(fd, 'work', () => undefined);
      if (record.evaluationId !== evaluationId || !isDeepStrictEqual(manifest.commits, record.commits) ||
          !isDeepStrictEqual(manifest.files.map(file => file.name), expectedFiles) ||
          !isDeepStrictEqual(dir, new Set([manifestName, ...expectedFiles]))) {
        throw new Error('Consumer evidence inventory or commit mismatch.');
      }
      const plan = verifyPackages(record, files);
      verifySummary(record, files.get(summaryName)!, plan);
      if (fstatSync(fd, { bigint: true }).ctimeNs !== before.ctimeNs) throw new Error('Consumer evidence directory changed.');
      return { verified: true, manifestSha256, record };
    });
  });
}

function verificationRequest(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], options: {
    'evaluation-id': { type: 'string', multiple: true }, json: { type: 'boolean', multiple: true },
    'clu-sha': { type: 'string', multiple: true }, 'dgi-sha': { type: 'string', multiple: true },
    'manifest-sha256': { type: 'string', multiple: true },
  } });
  const { 'evaluation-id': id, json: format, 'clu-sha': clu, 'dgi-sha': dgi, 'manifest-sha256': manifest } = values;
  if (id?.length !== 1 || [format, clu, dgi, manifest].some(value => value && value.length !== 1) ||
      (clu && !shaPattern.test(clu[0]!)) || (dgi && !shaPattern.test(dgi[0]!)) ||
      (manifest && !/^[a-f0-9]{64}$/.test(manifest[0]!))) {
    throw new Error('Supply consumer verify --evaluation-id <uuid> [--json] [--clu-sha <sha>] [--dgi-sha <sha>] [--manifest-sha256 <digest>].');
  }
  return { id: id[0]!, expected: { clu: clu?.[0], dgi: dgi?.[0], manifestSha256: manifest?.[0] } };
}

export function verifyConsumerCli(args: readonly string[]) {
  const format = args.includes('--json');
  try {
    const { id, expected } = verificationRequest(args);
    const result = verifyConsumerEvidence(id, expected);
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
  } catch {
    const reason = 'Invalid or unavailable consumer evidence.';
    return { exitCode: 2, stderr: format ? JSON.stringify({ verified: false, reason }) : reason };
  }
}
