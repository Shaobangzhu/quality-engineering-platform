import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import ts from 'typescript';
import { cluPackage } from './clu-candidate-archive.js';
import { readVerifiedCandidate } from './clu-candidate.js';
import { archiveFile, frontendFile, lockFile, planCandidateDelta, readInstalledLock, regularBytes } from './dgi-candidate-lock.js';
import { verifyDependencies } from './install-policy.js';
import { isRecord } from './metadata.js';
import { installedNpm } from './plan.js';
import { childEnvironment, verifyCheckout } from './run-policy.js';
import { runProcess } from './run-process.js';
import { git } from './source-git.js';
import { checkoutWorkspace, prepareWorkspace, reserveWorkspace, verifyWorkspaceSource } from './workspace.js';

const origins = new Set(['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'].flatMap(base =>
  ['', '.git'].map(suffix => base + 'shaobangzhu/delivery-geo-intelligence' + suffix + '\n')));
const changes = { tracked: [frontendFile, lockFile], files: [archiveFile] };
const usage = 'Supply candidate inject --source <absolute-dgi-path> --sha <reviewed-dgi-sha> ' +
  '--candidate-sha <clu-producer-sha> --integrity <sha512-sri> [--install-deps].';

function checkOrigin(path: string) {
  const origin = git(path, ['config', '--local', '--no-includes', '--get-all', 'remote.origin.url'], 'approved DGI origin');
  if (!origins.has(origin.toLowerCase())) throw new Error('Source origin must identify the approved DGI repository.');
}

function parseRequest(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], options: {
    source: { type: 'string', multiple: true }, sha: { type: 'string', multiple: true },
    'candidate-sha': { type: 'string', multiple: true }, integrity: { type: 'string', multiple: true },
    'install-deps': { type: 'boolean', multiple: true },
  } });
  const { source, sha, 'candidate-sha': candidateSha, integrity, 'install-deps': install } = values;
  if (source?.length !== 1 || sha?.length !== 1 || candidateSha?.length !== 1 || integrity?.length !== 1 ||
      (install !== undefined && install.length !== 1) || ![sha[0], candidateSha[0]].every(value => /^[a-f0-9]{40}$/i.test(value)) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity[0])) throw new Error(usage);
  return { source: source[0], sha: sha[0].toLowerCase(), candidateSha: candidateSha[0].toLowerCase(),
    integrity: integrity[0], install: install?.[0] === true };
}

function equalBytes(path: string, expected: Buffer, message: string) {
  try {
    if (regularBytes(path, expected.length).equals(expected)) return;
  } catch (cause) {
    throw new Error(message, { cause });
  }
  throw new Error(message);
}

type InstallRun = (label: string, executable: string, args: string[], cwd: string, collect?: (chunk: string) => void) => Promise<void>;

async function verifyInstalled(workspace: string, plan: ReturnType<typeof planCandidateDelta>,
  archive: ReturnType<typeof readVerifiedCandidate>['archive'], step: InstallRun) {
  const hidden = readInstalledLock(workspace);
  if (hidden.lockfileVersion !== 3 || !isRecord(hidden.packages) ||
      !isDeepStrictEqual(hidden.packages[plan.packageLocation], plan.candidateEntry)) {
    throw new Error('Installed npm lockfile must record the approved CLU file resolution and SHA-512 integrity.');
  }
  verifyDependencies(workspace, { ...plan.profile, tool: 'node', toolWorkspace: '' }, plan.install);
  const packageRoot = join(workspace, plan.packageLocation);
  const installedMembers = readdirSync(packageRoot, { recursive: true, withFileTypes: true }).filter(file => file.isFile());
  if (installedMembers.length !== archive.members.size) throw new Error('Installed CLU file inventory differs from the approved archive.');
  for (const [path, bytes] of archive.members) {
    equalBytes(join(packageRoot, path), bytes, 'Installed CLU package does not match the approved archive.');
  }

  const frontend = join(workspace, 'frontend');
  const javascript = join(packageRoot, 'dist/index.js');
  const declaration = join(packageRoot, 'dist/index.d.ts');
  const stylesheet = join(packageRoot, 'dist/styles.css');
  const reactRoot = join(workspace, plan.reactLocation);
  // Resolve from both importers without evaluating the installed modules.
  let output = '';
  await step('Node export resolution', process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '--eval', `
    const [clu, parent] = process.argv.slice(1);
    console.log(JSON.stringify([import.meta.resolve(clu), import.meta.resolve(clu + '/styles.css'),
      import.meta.resolve('react'), import.meta.resolve('react', parent)]));
  `, cluPackage, pathToFileURL(javascript).href], frontend, chunk => {
    if (output.length < 32 * 1024) output += chunk;
  });
  const resolved: unknown = JSON.parse(output);
  if (!Array.isArray(resolved) || resolved.length !== 4 || resolved[0] !== pathToFileURL(javascript).href ||
      resolved[1] !== pathToFileURL(stylesheet).href) {
    throw new Error('Installed CLU ESM and styles.css exports must resolve to the verified dist files.');
  }
  const reactPrefix = pathToFileURL(reactRoot + sep).href;
  if (typeof resolved[2] !== 'string' || !resolved[2].startsWith(reactPrefix) || resolved[2] !== resolved[3]) {
    throw new Error('The DGI frontend and CLU must resolve the same installed React entry point.');
  }
  const react = createRequire(join(frontend, 'package.json')).resolve('react');
  if (!react.startsWith(reactRoot + sep) || realpathSync(react) !== react ||
      createRequire(javascript).resolve('react') !== react) {
    throw new Error('The frontend and CLU must share one physical React installation.');
  }
  const reactDom = plan.profile.workspaceManifests.get('frontend')?.dependencies;
  if (isRecord(reactDom) && Object.hasOwn(reactDom, 'react-dom') &&
      createRequire(createRequire(join(frontend, 'package.json')).resolve('react-dom')).resolve('react') !== react) {
    throw new Error('React DOM must use the same installed React as the frontend and CLU.');
  }

  const inside = (path: string) => path === workspace || path.startsWith(workspace + sep);
  const typeResolution = ts.resolveModuleName(cluPackage, join(frontend, 'qep-consumer.ts'),
    { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext }, {
      fileExists: path => inside(path) && ts.sys.fileExists(path),
      directoryExists: path => inside(path) && ts.sys.directoryExists(path),
      readFile: path => inside(path) ? ts.sys.readFile(path) : undefined,
    }, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
  if (typeResolution !== declaration) throw new Error('TypeScript must resolve the installed CLU dist/index.d.ts.');
  return { javascript, declaration, stylesheet, react, reactVersion: plan.reactVersion };
}

export async function injectCandidate(args: readonly string[]) {
  const request = parseRequest(args);
  if (process.platform !== 'linux') throw new Error('DGI candidate injection requires Linux process groups and procfs.');
  const approved = readVerifiedCandidate(request.candidateSha);
  if (request.integrity !== approved.receipt.integrity) throw new Error('The archive SHA-512 does not match the approved integrity.');
  const preparation = prepareWorkspace({ suite: 'dgi-frontend-unit', source: request.source, sha: request.sha }, 'consumer-gate');
  const { suite, source } = preparation;
  checkOrigin(source.path);
  const reservation = reserveWorkspace(preparation);
  const { runId, runPath } = reservation;
  const reserved = lstatSync(runPath, { bigint: true });
  const baseline = { ...reservation, workspace: join(runPath, 'baseline') };
  const candidate = { ...reservation, workspace: join(runPath, 'candidate') };
  const archivePath = join(candidate.workspace, archiveFile);
  const abort = new AbortController();
  const interrupt = () => abort.abort('SIGINT');
  const terminate = () => abort.abort('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let retained = false;
  let cleanupSafe = true;
  try {
    checkoutWorkspace(baseline, preparation);
    checkoutWorkspace(candidate, preparation);
    verifyCheckout(baseline, suite);
    verifyCheckout(candidate, suite);
    const plan = planCandidateDelta(baseline.workspace, approved.archive);
    writeFileSync(archivePath, approved.bytes, { flag: 'wx', mode: 0o400 });
    for (const { path, before, after } of plan.files) {
      const target = join(candidate.workspace, path);
      equalBytes(target, before, 'The detached checkouts differ before injection.');
      const replacement = target + '.qep-injection';
      writeFileSync(replacement, after, { flag: 'wx', mode: lstatSync(target).mode & 0o777 });
      renameSync(replacement, target);
    }
    function verifyDelta(roots: readonly string[] = []) {
      verifyCheckout(baseline, suite);
      verifyCheckout(candidate, suite, roots, changes);
      for (const { path, before, after } of plan.files) {
        equalBytes(join(baseline.workspace, path), before, 'The baseline dependency files changed.');
        equalBytes(join(candidate.workspace, path), after, 'Unexpected candidate dependency delta in ' + path + '.');
      }
      equalBytes(archivePath, approved.bytes, 'The workspace archive SHA-512 changed.');
    }

    verifyDelta();
    let installed: Awaited<ReturnType<typeof verifyInstalled>> | null = null;
    if (request.install) {
      const npm = installedNpm();
      const runtime = join(runPath, 'runtime');
      mkdirSync(runtime, { mode: 0o700 });
      const env = { ...childEnvironment(runtime), npm_config_registry: 'https://registry.npmjs.org/' };
      const step: InstallRun = async (label, executable, args, cwd, collect) => {
        const result = await runProcess(executable, args, cwd, env, 300_000, abort.signal, false, collect);
        if (result.failureCategory === 'cleanup') cleanupSafe = false;
        if (result.status !== 'PASS') throw new Error('DGI ' + label + ' failed (' + result.failureCategory + ').');
      };
      await step('candidate npm ci', process.execPath, [npm.executable, 'ci', '--ignore-scripts', '--include=dev'], candidate.workspace);
      verifyDelta(plan.install.roots);
      installed = await verifyInstalled(candidate.workspace, plan, approved.archive, step);
      verifyDelta(plan.install.roots);
    }
    verifyWorkspaceSource(preparation);
    checkOrigin(source.path);
    if (abort.signal.aborted) throw new Error('DGI candidate injection was cancelled.');
    retained = true;
    return { runId, source, baseline: { workspace: baseline.workspace, published: plan.published },
      candidate: { workspace: candidate.workspace, archivePath, producerSha: request.candidateSha,
        ...plan.candidateEntry }, installed, status: installed ? 'installed-and-verified' : 'prepared' };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    if (!retained && cleanupSafe) {
      const current = lstatSync(runPath, { bigint: true, throwIfNoEntry: false });
      if (current?.dev === reserved.dev && current.ino === reserved.ino) rmSync(runPath, { recursive: true });
    }
  }
}
