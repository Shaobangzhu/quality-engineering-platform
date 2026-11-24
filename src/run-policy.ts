import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, readManifest } from './metadata.js';
import { checkProject } from './plan.js';
import { checkSourceGit, git } from './source-git.js';
import { auditedDgiSha, type SuiteDefinition } from './suite-catalog.js';
import type { Workspace } from './workspace.js';
import { Blocked } from './run-process.js';
import type { EvidenceFormat } from './test-evidence.js';
import { approvedNpmrc } from './workspace-tree.js';

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
    npm_config_ignore_scripts: 'true', NO_COLOR: '1',
  };
}

export function verifyCheckout(run: Workspace, suite: SuiteDefinition, dependencyRoots: readonly string[] = []) {
  const { workspace, source } = run;
  if (realpathSync(workspace) !== workspace || suite.id !== run.suiteId || suite.repository !== source.repository ||
      git(workspace, ['rev-parse', '--symbolic-full-name', 'HEAD'], 'workspace reference') !== 'HEAD\n' ||
      git(workspace, ['remote'], 'workspace remotes') !== '') throw new Blocked('integrity');
  checkSourceGit(workspace, source.sha, false, dependencyRoots);
  checkProject(workspace, suite);
  const npmrc = join(workspace, '.npmrc');
  const config = lstatSync(npmrc, { throwIfNoEntry: false });
  if (!config) return;
  if (suite.id !== 'clu-unit' || !config.isFile() || config.size > 256) throw new Blocked('integrity');
  const fd = openSync(npmrc, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(257);
    const observed = fstatSync(fd);
    if (!observed.isFile()) throw new Blocked('integrity');
    const size = readSync(fd, buffer);
    if (size !== observed.size || size > 256 || !approvedNpmrc(buffer.toString('utf8', 0, size))) {
      throw new Blocked('integrity');
    }
  } finally {
    closeSync(fd);
  }
}

export const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const dgiWorkspaces = ['backend', 'frontend'] as const;

export type SuiteProfile = {
  manifest: Record<string, unknown>;
  workspaceManifests: ReadonlyMap<string, Record<string, unknown>>;
  needsDeps: boolean;
  tool: string;
  toolWorkspace: string;
  format: EvidenceFormat;
};

function reviewedScript(manifest: Record<string, unknown>, name: string) {
  const { scripts } = manifest;
  if (!isRecord(scripts) || typeof scripts[name] !== 'string') throw new Blocked('unsupported-profile');
  if (scripts['pre' + name] || scripts['post' + name]) throw new Blocked('lifecycle-review');
  return scripts[name];
}

export function inspectDgiChain(workspace: string, sha: string, suite: SuiteDefinition, manifest: Record<string, unknown>) {
  const declared = manifest.workspaces;
  if (sha !== auditedDgiSha || suite.id === 'clu-unit' || !Array.isArray(declared) ||
      declared.length !== dgiWorkspaces.length || !dgiWorkspaces.every(name => declared.includes(name))) {
    throw new Blocked('unsupported-profile');
  }
  const workspaceManifests = new Map(dgiWorkspaces.map(name => {
    const path = join(workspace, name, 'package.json');
    if (realpathSync(path) !== path) throw new Blocked('unsupported-profile');
    const local = readManifest(path, 'DGI workspace package.json');
    if (local.name !== name) throw new Blocked('unsupported-profile');
    return [name, local] as const;
  }));
  const backend = suite.id === 'dgi-backend-unit';
  const target = backend ? 'backend' : 'frontend';
  const local = workspaceManifests.get(target)!;
  const expectedDispatch = backend ? 'npm run test:unit -w backend' : 'npm test -w frontend';
  const expectedTest = backend ? 'npm run build && node test/run.mjs unit' : 'node ../scripts/allure/run.mjs frontend unit run';
  const expectedBuild = `node --input-type=module -e "import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true });" && tsc`;
  if (reviewedScript(manifest, suite.command.args[1]!) !== expectedDispatch ||
      reviewedScript(local, backend ? 'test:unit' : 'test') !== expectedTest ||
      (backend && reviewedScript(local, 'build') !== expectedBuild)) throw new Blocked('unsupported-profile');

  const format: EvidenceFormat = backend ? 'node-spec' : 'dgi-frontend-allure';
  return { workspaceManifests, tool: backend ? 'tsc' : 'vitest', toolWorkspace: target, format };
}

// Support direct unit-test invocations only. npm evaluates package scripts with
// a shell even when spawn has shell:false, so limit the script grammar as well.
export function inspectSuite(run: Workspace, suite: SuiteDefinition): SuiteProfile {
  const manifest = readManifest(join(run.workspace, 'package.json'), 'workspace package.json');
  const script = suite.command.args[1] ?? 'test';
  const command = reviewedScript(manifest, script).trim();
  if (manifest.workspaces !== undefined) {
    return { manifest, needsDeps: true, ...inspectDgiChain(run.workspace, run.source.sha, suite, manifest) };
  }
  const match = /^(node --test(?: --test-reporter=tap)?|node(?= [\w./-]+\.(?:[cm]?js)$)|vitest run|jest(?: --runInBand)?)(?: ([\w./ -]+))?$/.exec(command);
  // Operands may select local files. Options, traversal, shell expansions,
  // secondary commands and browser/DB/Docker profile switches are unsupported.
  if (!match || suite.requirements.database || suite.requirements.docker ||
      match[2]?.split(/ +/).some(part => !/^[\w.][\w./-]*$/.test(part) || part.split('/').includes('..') ||
        /(?:^|[./_-])(?:browser|e2e|playwright|puppeteer|cypress|docker|db|database|migrations?)(?:$|[./_-])/i.test(part))) {
    throw new Blocked('unsupported-profile');
  }
  const tool = command.split(' ')[0];
  const needsDeps = tool !== 'node' || dependencyFields.some(key => isRecord(manifest[key]) && Object.keys(manifest[key]).length > 0);
  return { manifest, needsDeps, tool, toolWorkspace: '', workspaceManifests: new Map<string, Record<string, unknown>>(),
    format: 'standard' };
}
