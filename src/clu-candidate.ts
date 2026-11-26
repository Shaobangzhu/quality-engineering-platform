import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToSignals } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { archiveDigests, archiveLimit, checkPackageManifest, cluPackage, exactVersion, jsonLimit, requiredMembers,
  verifyCandidateArchive } from './clu-candidate-archive.js';
import { checkInstall, verifyDependencies } from './install-policy.js';
import { isRecord, readManifest } from './metadata.js';
import { installedNpm } from './plan.js';
import { childEnvironment, inspectSuite, verifyCheckout } from './run-policy.js';
import { runProcess, type Outcome } from './run-process.js';
import { entries, localRoot, requirePrivateDirectory, withLocalStorage, type LocalStorage } from './run-storage.js';
import { git } from './source-git.js';
import { parseStrictJson } from './strict-json.js';
import { checkoutWorkspace, prepareWorkspace, type Workspace } from './workspace.js';

const storageName = 'consumer-gate';
const archiveName = 'candidate.tgz';
const receiptName = 'receipt.json';
const buildCommand = 'vite build && node scripts/build-types.mjs';
const unitCommand = 'vitest run';
const approvedOrigins = new Set([
  'https://github.com/shaobangzhu/react-clu-component-lib.git',
  'https://github.com/shaobangzhu/react-clu-component-lib',
  'git@github.com:shaobangzhu/react-clu-component-lib.git',
  'git@github.com:shaobangzhu/react-clu-component-lib',
  'ssh://git@github.com/shaobangzhu/react-clu-component-lib.git',
  'ssh://git@github.com/shaobangzhu/react-clu-component-lib',
]);
const forbiddenHooks = ['prebuild', 'postbuild', 'pretest', 'posttest', 'preinstall', 'install', 'postinstall',
  'prepublish', 'prepublishOnly', 'preprepare', 'prepare', 'postprepare', 'postpack'];

function checkOrigin(source: string) {
  const origin = git(source, ['config', '--local', '--no-includes', '--get-all', 'remote.origin.url'], 'approved CLU origin');
  if (!origin.endsWith('\n') || !approvedOrigins.has(origin.slice(0, -1).toLowerCase())) {
    throw new Error('Source origin must identify the approved CLU repository.');
  }
}

function candidateStorage<T>(inspect: (storage: LocalStorage, gate: number) => T) {
  return withLocalStorage(storage => {
    const gate = storage.child(storage.local, storageName, true);
    requirePrivateDirectory(gate);
    return inspect(storage, gate);
  });
}

function receiptFor(sha: string, version: string, npmVersion: string, bytes: Buffer) {
  return { schemaVersion: 1, producerSha: sha, name: cluPackage, version, npmVersion, archive: archiveName,
    ...archiveDigests(bytes), buildCommand, unitCommand };
}

function verifyCandidate(sha: string) {
  return candidateStorage((storage, gate) => storage.inspectChild(gate, sha, candidate => {
    const names = entries(candidate, 3);
    if (names.size !== 2 || !names.has(receiptName) || !names.has(archiveName)) {
      throw new Error('Candidate is incomplete or has unexpected stored files.');
    }
    const stored = parseStrictJson(storage.file(candidate, receiptName, jsonLimit), jsonLimit, 4, 20);
    if (!isRecord(stored) || !exactVersion(stored.npmVersion) || !exactVersion(stored.version)) {
      throw new Error('Invalid candidate receipt.');
    }
    const bytes = storage.file(candidate, archiveName, archiveLimit);
    const expected = receiptFor(sha, stored.version, stored.npmVersion, bytes);
    if (!isDeepStrictEqual(stored, expected)) throw new Error('Candidate receipt or archive digest mismatch.');
    const { manifest } = verifyCandidateArchive(bytes);
    if (manifest.version !== expected.version) throw new Error('Candidate package version differs from the receipt.');
    return expected;
  }));
}

function checkPackResult(packed: unknown, filename: string, verified: ReturnType<typeof verifyCandidateArchive>) {
  const { manifest, size, integrity, members } = verified;
  if (!Array.isArray(packed) || packed.length !== 1 || !isRecord(packed[0])) {
    throw new Error('Invalid npm pack result.');
  }
  const [item] = packed;
  const expectedFiles = [...members].map(([path, bytes]) => [path, bytes.length]).sort();
  const packedFiles: unknown = item.files;
  if (item.filename !== filename || item.name !== manifest.name || item.version !== manifest.version ||
      item.size !== size || item.integrity !== integrity || item.entryCount !== members.size ||
      !isDeepStrictEqual(item.bundled, []) || !Array.isArray(packedFiles) ||
      !packedFiles.every(file => isRecord(file) && typeof file.path === 'string' && typeof file.size === 'number') ||
      !isDeepStrictEqual(packedFiles.map(file => [file.path, file.size]).sort(), expectedFiles)) {
    throw new Error('npm pack metadata does not match the verified archive.');
  }
}

async function buildCandidate(sourcePath: string, sha: string) {
  if (process.platform !== 'linux') throw new Error('Candidate creation requires Linux process groups and procfs.');
  const preparation = prepareWorkspace({ suite: 'clu-unit', source: sourcePath, sha }, storageName);
  checkOrigin(preparation.source.path);
  candidateStorage(() => undefined);

  const candidate = join(preparation.runs, sha);
  try { mkdirSync(candidate, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A candidate reservation already exists for this SHA. Use candidate verify for retained bytes.');
    }
    throw error;
  }
  const reservation = lstatSync(candidate, { bigint: true });
  const runPath = join(candidate, 'work');
  const workspace = join(runPath, 'workspace');
  const run: Workspace = { runId: sha, runPath, workspace, suiteId: 'clu-unit', source: preparation.source };

  const abort = new AbortController();
  const interrupt = () => abort.abort('SIGINT');
  const terminate = () => abort.abort('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let cleanupSafe = true;
  let retained = false;
  try {
    mkdirSync(runPath, { mode: 0o700 });
    checkoutWorkspace(run, preparation);
    checkOrigin(preparation.source.path);
    verifyCheckout(run, preparation.suite);
    const manifest = readManifest(join(workspace, 'package.json'), 'candidate package.json');
    checkPackageManifest(manifest);
    const scripts = manifest.scripts;
    if (!isRecord(scripts) || scripts.build !== buildCommand || scripts.test !== unitCommand ||
        (Object.hasOwn(scripts, 'prepack') && scripts.prepack !== 'npm run build') ||
        forbiddenHooks.some(hook => Object.hasOwn(scripts, hook))) {
      throw new Error('Candidate has unexpected build, unit or lifecycle scripts.');
    }
    if (lstatSync(join(workspace, 'dist'), { throwIfNoEntry: false })) {
      throw new Error('Candidate checkout contains pre-existing build output.');
    }

    const profile = inspectSuite(run, preparation.suite);
    const install = checkInstall(workspace, profile);
    const npm = installedNpm();
    const env = childEnvironment(runPath);
    env.npm_config_script_shell = '/bin/sh';
    async function step(label: string, args: string[], format: 'standard' | false = false, capture = false) {
      let output = '';
      let overflow = false;
      const collect = capture ? (chunk: string) => {
        if (output.length + chunk.length > jsonLimit) overflow = true;
        if (!overflow) output += chunk;
      } : undefined;
      await yieldToSignals();
      const result: Outcome = await runProcess(process.execPath, [npm.executable, ...args], workspace, env,
        300_000, abort.signal, format, collect);
      if (result.failureCategory === 'cleanup') cleanupSafe = false;
      if (result.status !== 'PASS' || overflow) {
        throw new Error('Candidate ' + label + ' failed (' + (result.failureCategory ?? 'output limit') + ').');
      }
      return output;
    }

    const npmVersion = (await step('npm version check', ['--version'], false, true)).trim();
    if (!exactVersion(npmVersion) || npmVersion !== npm.version) throw new Error('Candidate npm version mismatch.');
    await step('install', ['ci', '--ignore-scripts', '--include=dev']);
    verifyCheckout(run, preparation.suite, install.roots);
    verifyDependencies(workspace, profile, install);
    await step('build', ['run', 'build', '--ignore-scripts']);
    const dist = join(workspace, 'dist');
    if (!lstatSync(dist, { throwIfNoEntry: false })?.isDirectory() || requiredMembers.filter(path => path.startsWith('dist/'))
      .some(path => !lstatSync(join(workspace, path), { throwIfNoEntry: false })?.isFile())) {
      throw new Error('Candidate build output is missing or unsafe.');
    }
    await step('unit suite', ['test', '--ignore-scripts'], 'standard');
    verifyCheckout(run, preparation.suite, [...install.roots, 'dist']);

    const output = await step('pack', ['pack', '--ignore-scripts', '--json', '--pack-destination', runPath], false, true);
    const filename = 'shaobangzhu-clu-ui-' + manifest.version + '.tgz';
    renameSync(join(runPath, filename), join(runPath, archiveName));
    const bytes = candidateStorage((storage, gate) => storage.inspectChild(gate, sha, root =>
      storage.inspectChild(root, 'work', scratch => storage.file(scratch, archiveName, archiveLimit))));
    const verified = verifyCandidateArchive(bytes);
    if (!isDeepStrictEqual(verified.manifest, manifest)) throw new Error('Packed manifest differs from the pinned manifest.');
    checkPackResult(parseStrictJson(Buffer.from(output), jsonLimit, 16, 4096), filename, verified);

    await yieldToSignals();
    if (abort.signal.aborted) throw new Error('Candidate creation was cancelled.');
    const receipt = receiptFor(sha, manifest.version, npmVersion, bytes);
    writeFileSync(join(candidate, archiveName), bytes, { flag: 'wx', mode: 0o400 });
    writeFileSync(join(runPath, receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
    renameSync(join(runPath, receiptName), join(candidate, receiptName));
    rmSync(runPath, { recursive: true });
    const result = verifyCandidate(sha);
    retained = true;
    return result;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    if (!retained && cleanupSafe) {
      const current = lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
      if (current?.dev === reservation.dev && current.ino === reservation.ino) rmSync(candidate, { recursive: true });
    }
  }
}

export async function candidateCli(args: readonly string[]) {
  const [command, ...options] = args;
  const { values } = parseArgs({ args: options, options: {
    source: { type: 'string', multiple: true }, sha: { type: 'string', multiple: true },
  } });
  if ((command !== 'build' && command !== 'verify') || values.sha?.length !== 1 ||
      (command === 'build' ? values.source?.length !== 1 : values.source !== undefined) ||
      !/^[a-f0-9]{40}$/i.test(values.sha[0])) {
    throw new Error('Supply candidate build --source <absolute-clu-path> --sha <40-char-sha> or candidate verify --sha <40-char-sha>.');
  }
  const sha = values.sha[0].toLowerCase();
  const receipt = command === 'build' ? await buildCandidate(values.source![0], sha) : verifyCandidate(sha);
  const directory = join(localRoot, storageName, sha);
  return { exitCode: 0, stdout: JSON.stringify({
    archivePath: join(directory, archiveName), receiptPath: join(directory, receiptName), ...receipt,
  }, null, 2) };
}
