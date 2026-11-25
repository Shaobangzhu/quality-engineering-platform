import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { parseRunSelection, reportFailure, verifyReportSelection } from './report-cli.js';
import { fileDigest } from './report-history.js';
import { reportFileLimits } from './report-output.js';
import { sha256 } from './result-contract-v1.js';
import { entries, fdPath, localRoot, requirePrivateDirectory, withLocalStorage, type LocalStorage } from './run-storage.js';
import { approvedSiteContent } from './site-content.js';

const deploymentRoot = '/home/clu/infra/qep-report-site';
const reportIdPattern = /^[a-f0-9]{64}$/;
const stagePattern = /^\.pending-[a-zA-Z0-9]{6}$/;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const uid = BigInt(process.geteuid!());
const stat = (path: string) => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const mode = (info: BigIntStats) => info.mode & 0o7777n;
const same = (a: BigIntStats, b: BigIntStats | undefined) => a.dev === b?.dev && a.ino === b.ino;
const targetFor = (reportId: string) => 'releases/' + reportId;
type HtmlDigest = ReturnType<typeof fileDigest>;
type Source = { reportId: string; html: Buffer; index: HtmlDigest; manifestSha256: string; ids: string[] };

class SiteError extends Error {}

function requireSite(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SiteError(message);
}

function withDeployment<T>(path: string, use: (root: number, recheck: () => void) => T): T {
  const installation = dirname(localRoot);
  requireSite(path.startsWith('/') && path !== '/' && normalize(path) === path && !path.endsWith('/') &&
    path !== installation && !path.startsWith(installation + '/') && !installation.startsWith(path + '/'),
  'Unsafe or overlapping deployment root.');
  const chain: { path: string; fd: number; identity: BigIntStats }[] = [];
  function pin(path: string) {
    const fd = openSync(path, directoryFlags);
    try {
      chain.push({ path, fd, identity: fstatSync(fd, { bigint: true }) });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return fd;
  }
  const parts = path.slice(1).split('/');
  function recheck() {
    const systemUid = chain[0].identity.uid;
    for (const [i, item] of chain.entries()) {
      const info = stat(item.path);
      requireSite(info && info.isDirectory() && same(item.identity, info), 'Deployment directory identity changed.');
      if (i === chain.length - 1) {
        const permissions = mode(info);
        requireSite(info.uid === uid && (permissions & 0o700n) === 0o700n && (permissions & 0o7022n) === 0n,
          'Deployment root must be owner-controlled.');
      } else {
        // The sticky system temporary directory supports isolated fixtures.
        const stickyTmp = i === 1 && parts[0] === 'tmp' && info.uid === systemUid && (info.mode & 0o1000n) !== 0n;
        requireSite((info.uid === uid || info.uid === 0n || info.uid === systemUid) &&
          ((info.mode & 0o022n) === 0n || stickyTmp), 'Unsafe deployment parent ownership or permissions.');
      }
    }
    const root = chain.at(-1)!.identity;
    for (const privatePath of [installation, localRoot]) {
      requireSite(!same(root, stat(privatePath)), 'Deployment root overlaps QEP storage.');
    }
  }
  try {
    let fd: number;
    try {
      fd = pin('/');
      for (const part of parts) fd = pin(join(fdPath(fd), part));
    } catch {
      throw new SiteError('Deployment root must already exist and have real directory parents.');
    }
    recheck();
    return use(fd, recheck);
  } finally {
    for (const { fd } of chain.reverse()) closeSync(fd);
  }
}

function lockPublication(root: number) {
  // The inherited directory descriptor holds the lock until the last close.
  const result = spawnSync('/usr/bin/flock', ['-n', '-E', '75', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', root], timeout: 5_000, killSignal: 'SIGKILL',
  });
  if (result.status === 75) throw new SiteError('Another site publisher is active.');
  requireSite(result.status === 0 && !result.error, 'Unable to lock site publication.');
}

function checkDirectory(info: BigIntStats | undefined, device: bigint, permissions: bigint) {
  requireSite(info?.isDirectory() && info.uid === uid && info.dev === device && mode(info) === permissions,
    'Unsafe site directory type, ownership or permissions.');
}

function checkHtml(path: string, device: bigint) {
  const info = stat(path);
  requireSite(info && info.isFile() && info.uid === uid && info.dev === device && info.nlink === 1n && mode(info) === 0o444n,
    'Unsafe site index.html type, ownership or permissions.');
  return info;
}

function inspectRelease(storage: LocalStorage, directory: number, device: bigint, index?: HtmlDigest) {
  const identity = fstatSync(directory, { bigint: true });
  checkDirectory(identity, device, 0o755n);
  requireSite(entries(directory, 2).size === 1, 'Unexpected site release inventory.');
  const path = join(fdPath(directory), 'index.html');
  const before = checkHtml(path, device);
  if (index) {
    requireSite(before.size === BigInt(index.bytes), 'Site index.html size does not match the verified report.');
    const bytes = storage.file(directory, 'index.html', reportFileLimits['index.html']);
    const after = checkHtml(path, device);
    requireSite(same(before, after) && before.ctimeNs === after.ctimeNs && sha256(bytes) === index.sha256,
      'Site index.html SHA-256 does not match the verified report.');
  }
  requireSite(fstatSync(directory, { bigint: true }).ctimeNs === identity.ctimeNs,
    'Site release directory changed during verification.');
  return identity;
}

function currentTarget(root: number) {
  const path = join(fdPath(root), 'current');
  const info = stat(path);
  if (!info) return null;
  requireSite(info.isSymbolicLink() && info.uid === uid, 'Unsafe site current pointer.');
  const target = readlinkSync(path);
  requireSite(target.startsWith('releases/') && reportIdPattern.test(target.slice('releases/'.length)) &&
    same(info, stat(path)), 'Unsafe site current target.');
  return target;
}

function withDirectory<T>(path: string, use: (fd: number) => T) {
  const fd = openSync(path, directoryFlags);
  try { return use(fd); } finally { closeSync(fd); }
}

function inspectDeployment(storage: LocalStorage, root: number, source: Source, device: bigint) {
  const base = fdPath(root);
  for (const name of readdirSync(base)) {
    if (name === 'releases' || name === 'current') continue;
    requireSite(stagePattern.test(name), 'Unexpected file in the deployment root.');
    const info = stat(join(base, name));
    if (info) checkDirectory(info, device, 0o700n);
  }
  const current = currentTarget(root);
  const path = join(base, 'releases');
  const releases = stat(path);
  let exists = false;
  if (releases) {
    checkDirectory(releases, device, 0o755n);
    withDirectory(path, fd => {
      requireSite(same(releases, fstatSync(fd, { bigint: true })), 'Site releases directory identity changed.');
      const names = readdirSync(fdPath(fd));
      requireSite(!current || names.includes(current.slice('releases/'.length)), 'Site current release is missing.');
      for (const name of names) {
        requireSite(reportIdPattern.test(name), 'Unexpected name in site releases.');
        const path = join(fdPath(fd), name);
        const index = name === source.reportId ? source.index : undefined;
        const identity = withDirectory(path, release => inspectRelease(storage, release, device, index));
        requireSite(same(identity, stat(path)), 'Site release directory identity changed.');
      }
      exists = names.includes(source.reportId);
    });
    requireSite(same(releases, stat(path)), 'Site releases directory identity changed.');
  } else {
    requireSite(!current, 'Site current release is missing.');
  }
  return { current, releases, exists };
}

function recordAuthorization(storage: LocalStorage, source: Source, deployment: string, previous: string | null) {
  requirePrivateDirectory(storage.local);
  const directory = join(fdPath(storage.local), 'site-receipts');
  if (!stat(directory)) mkdirSync(directory, { mode: 0o700 });
  const receipts = storage.child(storage.local, 'site-receipts', true);
  requirePrivateDirectory(receipts);
  const id = randomUUID();
  const pending = join(fdPath(receipts), '.pending-' + id);
  try {
    writeFileSync(pending, JSON.stringify({
      event: 'promotion-authorized', recordedAt: new Date().toISOString(), deployment, previous,
      target: targetFor(source.reportId), reportId: source.reportId, runIds: source.ids,
      index: source.index, manifestSha256: source.manifestSha256,
    }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    renameSync(pending, join(fdPath(receipts), id + '.json'));
    fsyncSync(receipts);
    fsyncSync(storage.local);
  } finally {
    rmSync(pending, { force: true });
  }
}

function stageAndPromote(
  storage: LocalStorage, root: number, source: Source, device: bigint, deployment: string,
  state: ReturnType<typeof inspectDeployment>, recheck: () => void,
) {
  requirePrivateDirectory(storage.local);
  const base = fdPath(root);
  const stagePath = mkdtempSync(join(base, '.pending-'));
  try {
    withDirectory(stagePath, stage => {
      checkDirectory(fstatSync(stage, { bigint: true }), device, 0o700n);
      const pending = join(fdPath(stage), 'release');
      const next = join(fdPath(stage), 'current');
      const target = targetFor(source.reportId);
      const releasesPath = join(base, 'releases');
      if (!state.releases) mkdirSync(releasesPath, { mode: 0o755 });
      withDirectory(releasesPath, releases => {
        if (!state.releases) fchmodSync(releases, 0o755);
        const releaseStore = fstatSync(releases, { bigint: true });
        checkDirectory(releaseStore, device, 0o755n);
        requireSite(!state.releases || same(state.releases, releaseStore), 'Site releases directory identity changed.');
        const destination = join(fdPath(releases), source.reportId);
        if (!state.exists) {
          mkdirSync(pending, { mode: 0o700 });
          withDirectory(pending, release => {
            const html = openSync(join(fdPath(release), 'index.html'), 'wx', 0o600);
            try {
              writeFileSync(html, source.html);
              fchmodSync(html, 0o444);
              fsyncSync(html);
            } finally { closeSync(html); }
            // Linux requires write permission on a directory moved between
            // parents. The published file is read-only and the CLI never
            // modifies an existing release directory.
            fchmodSync(release, 0o755);
            inspectRelease(storage, release, device, source.index);
            fsyncSync(release);
            recheck();
            recordAuthorization(storage, source, deployment, state.current);
            recheck();
            requireSite(same(releaseStore, stat(releasesPath)) && !stat(destination), 'Site release destination changed.');
            renameSync(pending, destination);
          });
        }
        const identity = withDirectory(destination, release => inspectRelease(storage, release, device, source.index));
        fsyncSync(releases);
        fsyncSync(root);
        if (state.exists) recordAuthorization(storage, source, deployment, state.current);
        symlinkSync(target, next);
        recheck();
        requireSite(same(releaseStore, stat(releasesPath)) && same(identity, stat(destination)) &&
          currentTarget(root) === state.current,
          'Site deployment changed before switching current.');
        renameSync(next, join(base, 'current'));
        fsyncSync(root);
        fsyncSync(stage);
      });
    });
  } finally {
    rmSync(stagePath, { recursive: true, force: true });
  }
}

export function siteCli(args: readonly string[], deployment = deploymentRoot) {
  try {
    const [action, ...options] = args;
    requireSite(action === 'plan' || action === 'promote' || action === 'verify', 'Supply site plan, promote or verify.');
    const selectors: string[] = [];
    let publish = 0;
    for (let i = 0; i < options.length; i++) {
      if (options[i] === '--publish') {
        publish++;
      } else {
        selectors.push(...options.slice(i, i + 2));
        i++;
      }
    }
    requireSite(action === 'promote' ? publish === 1 : publish === 0,
      'Only site promote accepts and requires one explicit --publish flag.');
    const ids = parseRunSelection(selectors, 'site ' + action);
    const verified = verifyReportSelection(ids);
    requireSite(approvedSiteContent(verified.content, verified.history.acceptedLaunches > 1),
      'Report violates the public single-file HTML policy.');
    const { reportId, html, manifest } = verified;
    const index = fileDigest('index.html', html);
    const source = { reportId, html, index, manifestSha256: sha256(manifest), ids };
    const target = targetFor(reportId);
    const outcome = withDeployment(deployment, (root, recheck) => withLocalStorage(storage => {
      if (action === 'promote') lockPublication(root);
      recheck();
      const device = fstatSync(root, { bigint: true }).dev;
      const state = inspectDeployment(storage, root, source, device);
      recheck();
      requireSite(currentTarget(root) === state.current, 'Site current changed during inspection.');
      if (action === 'plan') {
        return { status: 'planned', operation: state.current === target ? 'reuse' : state.exists ? 'activate' : 'publish' };
      }
      if (action === 'verify') {
        requireSite(state.current === target && state.exists, 'The selected report is not the verified current site release.');
        return { status: 'verified' };
      }
      if (state.current === target) return { status: 'reused' };
      stageAndPromote(storage, root, source, device, deployment, state, recheck);
      return { status: state.exists ? 'activated' : 'published' };
    }));
    return { exitCode: 0, stdout: JSON.stringify({ ...outcome, deploymentRoot: deployment, reportId, target, index }) };
  } catch (error) {
    if (error instanceof SiteError) return { exitCode: 2, stderr: error.message };
    return reportFailure(error, 'Invalid or unavailable site deployment or source report.');
  }
}
