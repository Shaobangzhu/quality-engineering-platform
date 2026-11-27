import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies } from 'semver';
import { cluPackage, exactVersion } from './clu-candidate-archive.js';
import { checkInstall } from './install-policy.js';
import { isRecord } from './metadata.js';
import { dependencyFields } from './run-policy.js';
import { parseStrictJson } from './strict-json.js';

export const archiveFile = 'qep-clu-candidate.tgz';
export const frontendFile = 'frontend/package.json';
export const lockFile = 'package-lock.json';
const frontendSpec = 'file:../' + archiveFile;
const lockResolution = 'file:' + archiveFile;
export const lockLimit = 16 * 1024 * 1024;
export const cluLocation = 'node_modules/' + cluPackage;
export const publishedCluIntegrity = /^(?:sha512-[A-Za-z0-9+/]{85}[AQgw]==|sha1-[A-Za-z0-9+/]{26}[AEIMQUYcgkosw048]=)$/;
const reactLocation = 'node_modules/react';
const publishedPolicy = 'The baseline must use a single published CLU version pinned by frontend.dependencies.';
const reactPolicy = 'DGI must lock one hoisted React installation compatible with the frontend and CLU React peer.';

type Manifest = Record<string, unknown>;

export function regularBytes(path: string, limit: number): Buffer {
  if (realpathSync(path) !== path) throw new Error('Expected a file inside the DGI checkout.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit)) {
      throw new Error('Expected a regular, unshared file inside the DGI checkout.');
    }
    const bytes = Buffer.alloc(Number(stat.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new Error('A DGI workspace file changed during verification.');
      offset += count;
    }
    if (fstatSync(fd, { bigint: true }).ctimeNs !== stat.ctimeNs) {
      throw new Error('A DGI workspace file changed during verification.');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function manifest(bytes: Buffer): Manifest {
  const value = parseStrictJson(bytes, lockLimit, 64, 100_000);
  if (!isRecord(value)) throw new Error('Expected a DGI JSON object.');
  return value;
}

function declaredWorkspaces(value: unknown) {
  return Array.isArray(value) && value.length === 2 && value.includes('frontend') && value.includes('backend');
}

function dependencySpec(pkg: Manifest, field: string, name: string) {
  const specs = pkg[field];
  return isRecord(specs) && Object.hasOwn(specs, name) ? specs[name] : undefined;
}

function hasCluOverride(overrides: unknown): boolean {
  return isRecord(overrides) && Object.entries(overrides).some(([key, value]) =>
    key === cluPackage || hasCluOverride(value));
}

function encodedLike(value: Manifest, original: Buffer) {
  const text = original.toString('utf8');
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const output = JSON.stringify(value, null, indent).replaceAll('\n', eol);
  return Buffer.from(output + (text.endsWith('\n') ? eol : ''));
}

type LockArchive = { manifest: Manifest & { version: string }; integrity: string };

function patchLock(lock: Manifest, bytes: Buffer, candidate: LockArchive) {
  if (lock.name !== 'delivery-geo-intelligence' || lock.lockfileVersion !== 3 || Object.hasOwn(lock, 'dependencies') ||
      !isRecord(lock.packages)) throw new Error('Expected the DGI v3 lockfile.');
  const lockedFrontend = lock.packages.frontend;
  const published = lock.packages[cluLocation];
  const react = lock.packages[reactLocation];
  const publishedSpec = isRecord(lockedFrontend) ? dependencySpec(lockedFrontend, 'dependencies', cluPackage) : undefined;
  const reactSpec = isRecord(lockedFrontend) ? dependencySpec(lockedFrontend, 'dependencies', 'react') : undefined;
  const peer = dependencySpec(candidate.manifest, 'peerDependencies', 'react');
  const locations = Object.keys(lock.packages);
  const countLocations = (name: string) => locations.filter(path => path === name || path.endsWith('/' + name)).length;
  if (!isRecord(lockedFrontend) || !isRecord(lockedFrontend.dependencies) || !isRecord(published) ||
      !exactVersion(published.version) || typeof publishedSpec !== 'string' || !satisfies(published.version, publishedSpec) ||
      countLocations(cluLocation) !== 1) {
    throw new Error(publishedPolicy);
  }
  if (!isRecord(react) || !exactVersion(react.version) || typeof reactSpec !== 'string' || !satisfies(react.version, reactSpec) ||
      typeof peer !== 'string' || !satisfies(react.version, peer) || countLocations(reactLocation) !== 1) {
    throw new Error(reactPolicy);
  }
  if (Object.entries(lock.packages).some(([path, entry]) => !isRecord(entry) || dependencyFields.some(field =>
    (path !== 'frontend' || field !== 'dependencies') && dependencySpec(entry, field, cluPackage) !== undefined))) {
    throw new Error(publishedPolicy);
  }
  const { version, resolved, integrity } = published;
  if (resolved !== 'https://registry.npmjs.org/' + cluPackage + '/-/clu-ui-' + version + '.tgz' ||
      typeof integrity !== 'string' || !publishedCluIntegrity.test(integrity)) {
    throw new Error('Invalid published CLU lock entry.');
  }
  const candidateEntry = { version: candidate.manifest.version, resolved: lockResolution, integrity: candidate.integrity,
    license: candidate.manifest.license,
    ...(candidate.manifest.engines !== undefined ? { engines: candidate.manifest.engines } : {}),
    peerDependencies: candidate.manifest.peerDependencies };
  const patched = encodedLike({ ...lock, packages: {
    ...lock.packages,
    frontend: { ...lockedFrontend, dependencies: { ...lockedFrontend.dependencies, [cluPackage]: frontendSpec } },
    [cluLocation]: candidateEntry,
  } }, bytes);
  return { patched, candidateEntry, reactVersion: react.version, published: { version, resolved, integrity } };
}

export function replayDgiCandidateLock(before: Buffer, candidate: LockArchive) {
  return patchLock(manifest(before), before, candidate);
}

export function planCandidateDelta(baseline: string, candidate: LockArchive) {
  const frontendBytes = regularBytes(join(baseline, frontendFile), lockLimit);
  const lockBytes = regularBytes(join(baseline, lockFile), lockLimit);
  const root = manifest(regularBytes(join(baseline, 'package.json'), lockLimit));
  const frontend = manifest(frontendBytes);
  const backend = manifest(regularBytes(join(baseline, 'backend', 'package.json'), lockLimit));
  const lock = manifest(lockBytes);
  if (!declaredWorkspaces(root.workspaces) || frontend.name !== 'frontend' || backend.name !== 'backend' ||
      lock.name !== root.name || lock.lockfileVersion !== 3 || Object.hasOwn(lock, 'dependencies') ||
      ['frontend', 'backend'].some(dir => lstatSync(join(baseline, dir, lockFile), { throwIfNoEntry: false }))) {
    throw new Error('DGI must use the frontend and backend npm workspaces with a single v3 root lockfile.');
  }
  const profile = { manifest: root, workspaceManifests: new Map([['frontend', frontend], ['backend', backend]]) };
  const install = checkInstall(baseline, profile);
  const { entries } = install;
  const { patched, candidateEntry, published, reactVersion } = patchLock(lock, lockBytes, candidate);
  const lockedFrontend = entries.get('frontend')!;
  if (dependencySpec(lockedFrontend, 'dependencies', cluPackage) !== dependencySpec(frontend, 'dependencies', cluPackage) ||
      [root, backend, frontend].some(pkg => hasCluOverride(pkg.overrides)) ||
      [root, backend, frontend].some(pkg => dependencyFields.some(field =>
        (pkg !== frontend || field !== 'dependencies') && dependencySpec(pkg, field, cluPackage) !== undefined))) {
    throw new Error(publishedPolicy);
  }

  if (dependencySpec(lockedFrontend, 'dependencies', 'react') !== dependencySpec(frontend, 'dependencies', 'react')) {
    throw new Error(reactPolicy);
  }

  // Root lockfile paths are relative to the repository. The manifest and
  // packages.frontend dependency paths are relative to frontend/.
  const candidateFrontend = { ...frontend, dependencies: { ...(frontend.dependencies as Manifest), [cluPackage]: frontendSpec } };
  const candidateManifests = new Map(profile.workspaceManifests).set('frontend', candidateFrontend);
  const candidateEntries = new Map(entries).set(cluLocation, candidateEntry);
  return {
    files: [
      { path: frontendFile, before: frontendBytes, after: encodedLike(candidateFrontend, frontendBytes) },
      { path: lockFile, before: lockBytes, after: patched },
    ],
    baseline: { profile, install },
    profile: { ...profile, workspaceManifests: candidateManifests }, install: { ...install, entries: candidateEntries },
    packageLocation: cluLocation, candidateEntry, reactLocation, reactVersion, published,
  };
}

export function readInstalledLock(workspace: string) {
  return manifest(regularBytes(join(workspace, 'node_modules', '.package-lock.json'), lockLimit));
}
