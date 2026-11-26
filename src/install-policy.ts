import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { isRecord, readManifest } from './metadata.js';
import { Blocked } from './run-process.js';
import { dependencyFields, type SuiteProfile } from './run-policy.js';

type Manifest = Record<string, unknown>;
const packageName = /^(?:@[a-zA-Z0-9][\w.-]*\/)?[a-zA-Z0-9_][\w.-]*$/;
const dependencyPath = /^(?:node_modules\/(?:@[\w.-]+\/)?[\w-][\w.-]*)(?:\/node_modules\/(?:@[\w.-]+\/)?[\w-][\w.-]*)*$/;
const registryTarball = /^https:\/\/registry\.npmjs\.org\/[\w@./+-]+\.tgz$/;
const registryIntegrity = /^(?:sha512-[A-Za-z0-9+/]{86}==|sha1-[A-Za-z0-9+/]{27}=)$/;
const registrySpec = /^[\w.*~^<>= |+-]+$/;
const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });

function checkDependencies(pkg: Manifest) {
  for (const field of dependencyFields) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (!isRecord(deps) || Object.entries(deps).some(([name, spec]) =>
      !packageName.test(name) || typeof spec !== 'string' || !registrySpec.test(spec))) {
      throw new Blocked('unsupported-install');
    }
  }
}

function checkOverrides(value: unknown, depth = 0): void {
  if (!isRecord(value) || depth > 16) throw new Blocked('unsupported-install');
  for (const [key, target] of Object.entries(value)) {
    if (key !== '.' && !packageName.test(key)) throw new Blocked('unsupported-install');
    if (typeof target === 'string' && registrySpec.test(target)) continue;
    checkOverrides(target, depth + 1);
  }
}

function checkLocalManifest(workspace: string, location: string, pkg: Manifest) {
  if (stat(join(workspace, location, 'npm-shrinkwrap.json')) || (location && pkg.workspaces !== undefined) ||
      pkg.bundleDependencies !== undefined || pkg.bundledDependencies !== undefined) throw new Blocked('unsupported-install');
  const scripts = pkg.scripts;
  if ((isRecord(scripts) && ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']
    .some(key => scripts[key])) || stat(join(workspace, location, 'binding.gyp'))) throw new Blocked('lifecycle-review');
  checkDependencies(pkg);
  if (pkg.overrides !== undefined) checkOverrides(pkg.overrides);
}

function isTarball(value: unknown): value is string {
  return typeof value === 'string' && registryTarball.test(value) && !value.split('/').slice(3).some(
    part => part === '.' || part === '..' || !part);
}

function checkLegacyLock(value: unknown, depth = 0): void {
  if (!isRecord(value) || depth > 64) throw new Blocked('unsupported-install');
  for (const [name, pkg] of Object.entries(value)) {
    if (!packageName.test(name) || !isRecord(pkg) || typeof pkg.version !== 'string' ||
        !registrySpec.test(pkg.version) || (pkg.resolved !== undefined && !isTarball(pkg.resolved))) {
      throw new Blocked('unsupported-install');
    }
    if (pkg.requires !== undefined) checkDependencies({ dependencies: pkg.requires });
    if (pkg.dependencies !== undefined) checkLegacyLock(pkg.dependencies, depth + 1);
  }
}

function isRegistryPackage(pkg: Manifest, name: string): boolean {
  return packageName.test(name) && isTarball(pkg.resolved) && typeof pkg.version === 'string' &&
    pkg.resolved === 'https://registry.npmjs.org/' + name + '/-/' + basename(name) + '-' + pkg.version + '.tgz' &&
    typeof pkg.integrity === 'string' && registryIntegrity.test(pkg.integrity);
}

const oxidePath = 'node_modules/@tailwindcss/oxide-wasm32-wasi';
const oxideBundles = ['@napi-rs/wasm-runtime', '@emnapi/core', '@emnapi/runtime', '@tybys/wasm-util', '@emnapi/wasi-threads', 'tslib'];

function bundledPackage(path: string, pkg: Manifest, entries: ReadonlyMap<string, Manifest>): boolean {
  // The child comes from its enclosing tarball, whose integrity npm verifies.
  const split = path.lastIndexOf('/node_modules/');
  if (split < 0 || pkg.inBundle !== true || pkg.link !== undefined ||
      pkg.resolved !== undefined || pkg.integrity !== undefined) return false;
  const parentPath = path.slice(0, split);
  const parent = entries.get(parentPath);
  return parentPath === oxidePath && parent?.version === '4.3.4' &&
    parent.integrity === 'sha512-bjO9WmoM687p8AoCIyw1DUqzpAs4JICLvNmIPxIWDmhw8IOsdubtWQLShyJmISnDKtRy1BBApHVOUl6sNFQQJA==' &&
    isRegistryPackage(parent, '@tailwindcss/oxide-wasm32-wasi') && Array.isArray(parent.bundleDependencies) &&
    oxideBundles.includes(path.slice(split + '/node_modules/'.length)) &&
    parent.bundleDependencies.includes(path.slice(split + '/node_modules/'.length));
}

// npm records the upstream development workspaces of some published tarballs.
// These declarations resolve no local path in the consuming installation.
const publishedWorkspaceMetadata = new Map([
  ['node_modules/clipanion', ['sha512-CXkMQxU6s9GklO/1f714dkKBMu1lopS1WFF0B8o4AxPykR1hpozxSiUZ5ZUeBjfPgCWqbcNOtZVFhB8Lkfp1+Q==', 'website']],
  ['node_modules/es-toolkit', ['sha512-XTNEJQh1tY1ZJVcf6ayP/2n4ZPyaHlW2FWs7xvw5ddPuhUVjLD3olQVQS7kf58JbAB48iL0uL/jerTrjtV3lDA==',
    'docs', 'benchmarks', 'tests/types', 'tests/browser-compat']],
  ['node_modules/typanion', ['sha512-ZW/lVMRabETuYCd9O9ZvMhAh8GslSqaUjxmK/JLPCh6l73CvLBiuXswj/+7LdnWOgYsQ130FqLzFz5aGT4I3Ug==', 'website']],
  ['node_modules/eslint', ['sha512-T0pNsxkb9IKmtQjhpK3d7nWOpFv+YHuMbTJnSVMoQblF0onvXfErrtp4V1jHtsQPan7dKaGVD0q1WCXnzMF31A==', 'packages/*']],
]);

type InstallManifests = Pick<SuiteProfile, 'manifest' | 'workspaceManifests'>;

export function checkInstall(workspace: string, profile: InstallManifests) {
  const locals = new Map<string, Manifest>([['', profile.manifest], ...profile.workspaceManifests]);
  for (const [location, pkg] of locals) checkLocalManifest(workspace, location, pkg);
  let lock;
  try { lock = readManifest(join(workspace, 'package-lock.json'), 'workspace package-lock.json'); }
  catch { throw new Blocked('unsupported-install'); }
  if ((lock.lockfileVersion !== 3 && (lock.lockfileVersion !== 2 || locals.size !== 1)) ||
      !isRecord(lock.packages) || !isRecord(lock.packages[''])) throw new Blocked('unsupported-install');
  if (lock.dependencies !== undefined) checkLegacyLock(lock.dependencies);
  const root = lock.packages[''];
  const workspaces = [...profile.workspaceManifests.keys()];
  const declared = root.workspaces;
  if ((workspaces.length && (!Array.isArray(declared) || declared.length !== workspaces.length ||
        !workspaces.every(name => declared.includes(name)))) ||
      (!workspaces.length && declared !== undefined) ||
      (root.name !== undefined && root.name !== profile.manifest.name)) throw new Blocked('unsupported-install');

  const entries = new Map<string, Manifest>();
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!isRecord(pkg)) throw new Blocked('unsupported-install');
    entries.set(path, pkg);
  }
  for (const name of workspaces) {
    const pkg = entries.get(name);
    const link = entries.get('node_modules/' + name);
    if (!pkg || pkg.version !== locals.get(name)?.version ||
        (pkg.name !== undefined && pkg.name !== name) ||
        !link || link.link !== true || link.resolved !== name || Object.keys(link).length !== 2) {
      throw new Blocked('unsupported-install');
    }
  }
  // Third-party install metadata is informational because npm ci disables lifecycle scripts.
  for (const [path, pkg] of entries) {
    checkDependencies(pkg);
    if (locals.has(path)) {
      if (pkg.link !== undefined || pkg.resolved !== undefined || pkg.integrity !== undefined ||
          (path && pkg.workspaces !== undefined)) throw new Blocked('unsupported-install');
      continue;
    }
    if (pkg.link === true && workspaces.some(name => path === 'node_modules/' + name && pkg.resolved === name)) continue;

    const separator = path.indexOf('/');
    const relative = workspaces.includes(path.slice(0, separator)) ? path.slice(separator + 1) : path;
    if (!dependencyPath.test(relative) || typeof pkg.version !== 'string' || !registrySpec.test(pkg.version) ||
        pkg.link !== undefined) throw new Blocked('unsupported-install');
    if (pkg.workspaces !== undefined) {
      const reviewed = publishedWorkspaceMetadata.get(path);
      const declared = pkg.workspaces;
      if (!reviewed || pkg.integrity !== reviewed[0] || !Array.isArray(declared) ||
          declared.length !== reviewed.length - 1 || !declared.every((name, index) => name === reviewed[index + 1])) {
        throw new Blocked('unsupported-install');
      }
    }
    if (pkg.inBundle !== undefined) {
      if (!bundledPackage(path, pkg, entries)) throw new Blocked('unsupported-install');
    } else if (!isRegistryPackage(pkg, relative.split('node_modules/').at(-1)!)) {
      throw new Blocked('unsupported-install');
    }
  }
  return { entries, roots: ['node_modules', ...workspaces.map(name => name + '/node_modules')] };
}

function binEntries(pkg: Manifest, name: string): Record<string, unknown> {
  if (typeof pkg.bin === 'string') return { [basename(name)]: pkg.bin };
  return isRecord(pkg.bin) ? pkg.bin : {};
}

export function verifyDependencies(workspace: string, profile: InstallManifests & Pick<SuiteProfile, 'tool' | 'toolWorkspace'>,
  install: ReturnType<typeof checkInstall>) {
  const { entries, roots } = install;
  const installed = new Set<string>();

  function scanFiles(path: string, packageRoot: string) {
    for (const name of readdirSync(join(workspace, path))) {
      const child = path + '/' + name;
      if (name === 'node_modules' && path === packageRoot) {
        scanModules(child);
      } else {
        const file = lstatSync(join(workspace, child));
        if (file.isDirectory()) scanFiles(child, packageRoot);
        else if (!file.isFile() || file.nlink !== 1) throw new Blocked('integrity');
      }
    }
  }

  function scanPackage(path: string, name: string) {
    const pkg = entries.get(path);
    if (!pkg) throw new Blocked('integrity');
    const absolute = join(workspace, path);
    const file = lstatSync(absolute);
    if (pkg.link === true) {
      if (!file.isSymbolicLink() || readlinkSync(absolute) !== '../' + pkg.resolved ||
          realpathSync(absolute) !== join(workspace, String(pkg.resolved))) {
        throw new Blocked('integrity');
      }
    } else {
      if (!file.isDirectory()) throw new Blocked('integrity');
      const local = readManifest(join(absolute, 'package.json'), 'installed package.json');
      if (local.name !== (pkg.name ?? name) || local.version !== pkg.version) throw new Blocked('integrity');
      scanFiles(path, path);
    }
    installed.add(path);
  }

  function scanModules(path: string) {
    const absolute = join(workspace, path);
    const dir = stat(absolute);
    if (!dir) return;
    if (!dir.isDirectory() || realpathSync(absolute) !== absolute) throw new Blocked('integrity');
    for (const name of readdirSync(absolute)) {
      const child = path + '/' + name;
      if (name === '.bin') continue;
      if (path === 'node_modules' && name === '.package-lock.json') {
        const lock = lstatSync(join(workspace, child));
        if (!lock.isFile() || lock.nlink !== 1) throw new Blocked('integrity');
      } else if (name.startsWith('@')) {
        if (!/^@[a-zA-Z0-9][\w.-]*$/.test(name) || !lstatSync(join(workspace, child)).isDirectory() ||
            ![...entries.keys()].some(key => key.startsWith(child + '/'))) {
          throw new Blocked('integrity');
        }
        for (const member of readdirSync(join(workspace, child))) scanPackage(child + '/' + member, name + '/' + member);
      } else {
        scanPackage(child, name);
      }
    }
    const binPath = join(absolute, '.bin');
    const bin = stat(binPath);
    if (!bin) return;
    if (!bin.isDirectory()) throw new Blocked('integrity');
    const bins = new Map<string, Set<string>>();
    for (const location of installed) {
      const name = location.slice(path.length + 1);
      if (!location.startsWith(path + '/') || !packageName.test(name)) continue;
      for (const [key, rel] of Object.entries(binEntries(entries.get(location)!, name))) {
        if (typeof rel !== 'string' || !/^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*$/.test(rel) ||
            rel.split('/').includes('..')) throw new Blocked('integrity');
        const targets = bins.get(key) ?? new Set<string>();
        targets.add(join(workspace, location, rel));
        bins.set(key, targets);
      }
    }
    for (const key of readdirSync(binPath)) {
      const path = join(binPath, key);
      if (['node', 'npm', 'git', 'sh', 'bash'].includes(key) || !lstatSync(path).isSymbolicLink() ||
          isAbsolute(readlinkSync(path))) throw new Blocked('integrity');
      const target = realpathSync(path);
      if (!bins.get(key)?.has(target) || !lstatSync(target).isFile()) throw new Blocked('integrity');
    }
  }

  for (const root of roots) scanModules(root);
  const locals = new Map<string, Manifest>([['', profile.manifest], ...profile.workspaceManifests]);
  for (const [name, manifest] of locals) {
    if (name && !installed.has('node_modules/' + name)) throw new Blocked('dependencies-required');
    for (const field of ['dependencies', 'devDependencies']) {
      const deps = manifest[field];
      if (!isRecord(deps)) continue;
      for (const dep of Object.keys(deps)) {
        if (isRecord(manifest.optionalDependencies) && Object.hasOwn(manifest.optionalDependencies, dep)) continue;
        const nested = name + '/node_modules/' + dep;
        const location = name && entries.has(nested) ? nested : 'node_modules/' + dep;
        if (!installed.has(location)) throw new Blocked('dependencies-required');
      }
    }
  }
  if (profile.tool !== 'node') {
    const toolPackage = profile.tool === 'tsc' ? 'typescript' : profile.tool;
    const directories = profile.toolWorkspace ? [profile.toolWorkspace, ''] : [''];
    const bin = directories.map(location => join(workspace, location, 'node_modules', '.bin', profile.tool))
      .find(path => stat(path)?.isSymbolicLink());
    if (!bin) throw new Blocked('dependencies-required');
    const target = realpathSync(bin);
    if (!directories.some(location => target.startsWith(join(workspace, location, 'node_modules', toolPackage) + '/'))) {
      throw new Blocked('integrity');
    }
  }
}
