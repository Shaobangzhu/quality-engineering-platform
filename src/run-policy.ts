import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, readManifest } from './metadata.js';
import { checkProject } from './plan.js';
import { checkSourceGit, git } from './source-git.js';
import type { SuiteDefinition } from './suite-catalog.js';
import type { Workspace } from './workspace.js';
import type { Outcome } from './run-process.js';

export class Blocked extends Error {
  constructor(readonly category: NonNullable<Outcome['failureCategory']>) { super(category); }
}

export function childEnvironment(runPath: string): NodeJS.ProcessEnv {
  const home = join(runPath, 'home');
  const tmp = join(runPath, 'tmp');
  for (const path of [home, tmp]) mkdirSync(path, { mode: 0o700 });
  return {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: home, TMPDIR: tmp, CI: 'true', TZ: 'UTC', NODE_ENV: 'test',
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '',
    npm_config_userconfig: join(home, '.npmrc'), npm_config_globalconfig: '/dev/null',
    npm_config_cache: join(home, '.npm'), npm_config_logs_max: '0',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'true', FORCE_COLOR: '0',
  };
}

export function verifyCheckout(run: Workspace, suite: SuiteDefinition, installed: boolean) {
  const { workspace, source } = run;
  if (realpathSync(workspace) !== workspace || suite.id !== run.suiteId || suite.repository !== source.repository ||
      git(workspace, ['rev-parse', '--symbolic-full-name', 'HEAD'], 'workspace reference') !== 'HEAD\n' ||
      git(workspace, ['remote'], 'workspace remotes') !== '') throw new Blocked('integrity');
  checkSourceGit(workspace, source.sha, false, installed);
  checkProject(workspace, suite);
}

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// Support direct unit-test invocations only. npm evaluates package scripts with
// a shell even when spawn has shell:false, so limit the script grammar as well.
export function inspectSuite(run: Workspace, suite: SuiteDefinition) {
  const manifest = readManifest(join(run.workspace, 'package.json'), 'workspace package.json');
  const script = suite.command.args[1] ?? 'test';
  const scripts = manifest.scripts;
  if (!isRecord(scripts)) throw new Blocked('integrity');
  if (scripts['pre' + script] || scripts['post' + script]) throw new Blocked('lifecycle-review');
  const command = String(scripts[script]).trim();
  const match = /^(node --test(?: --test-reporter=tap)?|node(?= [\w./-]+\.(?:[cm]?js)$)|vitest run|jest(?: --runInBand)?)(?: ([\w./ -]+))?$/.exec(command);
  // Operands may select local files. Options, traversal, shell expansions,
  // secondary commands and browser/DB/Docker profile switches are unsupported.
  if (!match || suite.requirements.database || suite.requirements.docker ||
      match[2]?.split(/ +/).some(part => !/^[\w.][\w./-]*$/.test(part) || part.split('/').includes('..') ||
        /(?:^|[./_-])(?:browser|e2e|playwright|puppeteer|cypress|docker|db|database|migrations?)(?:$|[./_-])/i.test(part))) {
    throw new Blocked('unsupported-profile');
  }
  const tool = command.split(' ')[0];
  const needsDeps = tool !== 'node' || Boolean(manifest.workspaces) ||
    dependencyFields.some(key => isRecord(manifest[key]) && Object.keys(manifest[key]).length > 0);
  return { manifest, scripts, needsDeps, tool };
}

// The first install path accepts conventional npm registry locks. Local paths,
// git dependencies and linked workspaces need a separate containment review.
export function checkInstall(workspace: string, manifest: Record<string, unknown>, scripts: Record<string, unknown>) {
  if (manifest.workspaces || lstatSync(join(workspace, 'npm-shrinkwrap.json'), { throwIfNoEntry: false })) {
    throw new Blocked('unsupported-install');
  }
  if (['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'].some(key => scripts[key]) ||
      lstatSync(join(workspace, 'binding.gyp'), { throwIfNoEntry: false })) throw new Blocked('lifecycle-review');
  let lock;
  try { lock = readManifest(join(workspace, 'package-lock.json'), 'workspace package-lock.json'); }
  catch { throw new Blocked('unsupported-install'); }
  if (![2, 3].includes(Number(lock.lockfileVersion)) || !isRecord(lock.packages) || !isRecord(lock.packages[''])) {
    throw new Blocked('unsupported-install');
  }
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!isRecord(pkg)) throw new Blocked('unsupported-install');
    if (pkg.hasInstallScript) throw new Blocked('lifecycle-review');
    if (path && (!/^(?:node_modules\/(?:@[\w.-]+\/)?[\w-][\w.-]*)(?:\/node_modules\/(?:@[\w.-]+\/)?[\w-][\w.-]*)*$/.test(path) ||
        pkg.link || typeof pkg.resolved !== 'string' || !/^https:\/\/registry\.npmjs\.org\/[\w@./%+-]+$/.test(pkg.resolved) ||
        typeof pkg.integrity !== 'string')) throw new Blocked('unsupported-install');
  }
  for (const pkg of [manifest, ...Object.values(lock.packages)]) {
    if (!isRecord(pkg)) throw new Blocked('unsupported-install');
    for (const field of dependencyFields) {
      const deps = pkg[field];
      if (deps === undefined) continue;
      if (!isRecord(deps) || Object.values(deps).some(spec => typeof spec !== 'string' ||
          !/^[\w.*~^<>= |+-]+$/.test(spec))) throw new Blocked('unsupported-install');
    }
  }
}

export function verifyDependencies(workspace: string, manifest: Record<string, unknown>, tool: string) {
  const modules = join(workspace, 'node_modules');
  for (const field of ['dependencies', 'devDependencies']) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (isRecord(manifest.optionalDependencies) && name in manifest.optionalDependencies) continue;
      if (!/^(?:@[\w.-]+\/)?[\w-][\w.-]*$/.test(name)) throw new Blocked('unsupported-install');
      const path = join(modules, name);
      if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory() || realpathSync(path) !== path) {
        throw new Blocked('dependencies-required');
      }
    }
  }
  if (tool === 'node') return;
  const bin = join(modules, '.bin', tool);
  if (!lstatSync(modules, { throwIfNoEntry: false })?.isDirectory() ||
      !lstatSync(bin, { throwIfNoEntry: false }) || !realpathSync(bin).startsWith(modules + '/')) {
    throw new Blocked('dependencies-required');
  }
}
