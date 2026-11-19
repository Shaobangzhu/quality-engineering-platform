import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { satisfies } from 'semver';
import packageMetadata from '#package' with { type: 'json' };
import { isRecord, readManifest } from './metadata.js';
import { checkSourceGit } from './source-git.js';
import { findSuite, type SuiteDefinition } from './suite-catalog.js';

function resolveSource(path: string): string {
  if (!isAbsolute(path)) throw new Error('Source path must be absolute.');
  try {
    const source = realpathSync(path);
    if (statSync(source).isDirectory()) return source;
  } catch {
    // Report the same error for missing and inaccessible directories.
  }
  throw new Error('Source path must resolve to an existing directory.');
}

function installedNpmVersion(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const executable = join(directory, 'npm');
    try {
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
    } catch {
      continue;
    }
    const launcher = realpathSync(executable);
    const bin = dirname(launcher);
    if (basename(bin) === 'bin' && basename(launcher) === 'npm-cli.js') {
      const manifest = readManifest(join(dirname(bin), 'package.json'), 'installed npm package.json');
      if (manifest.name === 'npm' && typeof manifest.version === 'string') return manifest.version;
    }
    break;
  }
  throw new Error('Cannot verify an installed npm runtime from its package metadata.');
}

function checkRuntime(engines: unknown): void {
  if (engines !== undefined && !isRecord(engines)) {
    throw new Error('Source package.json engines must be an object.');
  }
  const versions = { node: process.versions.node, npm: installedNpmVersion() };
  for (const runtime of ['node', 'npm'] as const) {
    if (!satisfies(versions[runtime], packageMetadata.engines[runtime])) {
      throw new Error(`Installed ${runtime} does not satisfy the QEP runtime requirement.`);
    }
    const range = engines?.[runtime];
    if (range !== undefined && (typeof range !== 'string' || !satisfies(versions[runtime], range))) {
      throw new Error(`Installed ${runtime} does not satisfy the source package.json engines requirement.`);
    }
  }
}

type ExecutionPlan = Readonly<{
  suiteId: SuiteDefinition['id'];
  source: Readonly<{ repository: SuiteDefinition['repository']; path: string; sha: string }>;
  command: SuiteDefinition['command'];
  workspace: Readonly<{ isolation: 'per-run'; path: string }>;
  requirements: SuiteDefinition['requirements'];
  artifacts: Readonly<{ path: string }>;
}>;

export function checkProject(path: string, suite: SuiteDefinition): void {
  const manifest = readManifest(join(path, 'package.json'), 'source package.json');
  if (manifest.name !== suite.repository) {
    throw new Error(`Source package.json name must be ${JSON.stringify(suite.repository)}.`);
  }
  const script = suite.command.args[1] ?? 'test';
  const scripts = manifest.scripts;
  if (!isRecord(scripts) || typeof scripts[script] !== 'string' || !scripts[script].trim()) {
    throw new Error(`Source package.json must define the npm script ${JSON.stringify(script)}.`);
  }
  checkRuntime(manifest.engines);
}

export function validateSource(suiteId: string, sourcePath: string, requestedSha: string, forClone = false) {
  const suite = findSuite(suiteId);
  if (!suite) throw new Error(`Unknown suite ${JSON.stringify(suiteId)}.`);
  if (requestedSha.length !== 40 || !/^[0-9a-f]+$/i.test(requestedSha)) {
    throw new Error('SHA must contain exactly 40 hexadecimal characters.');
  }
  const sha = requestedSha.toLowerCase();
  const path = resolveSource(sourcePath);
  checkSourceGit(path, sha, forClone);
  checkProject(path, suite);
  return { suite, source: { repository: suite.repository, path, sha } };
}

function createPlan(suiteId: string, sourcePath: string, requestedSha: string): ExecutionPlan {
  const { suite, source } = validateSource(suiteId, sourcePath, requestedSha);

  const runPath = `${suite.id}/${source.sha}/<run-id>`;
  return {
    suiteId: suite.id,
    source,
    command: suite.command,
    workspace: { isolation: 'per-run', path: '.local/runs/<run-id>/workspace' },
    requirements: suite.requirements,
    artifacts: { path: `reports/${runPath}` },
  };
}

export function parseSuiteArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      suite: { type: 'string', multiple: true },
      source: { type: 'string', multiple: true },
      sha: { type: 'string', multiple: true },
      json: { type: 'boolean', multiple: true },
    },
  });
  if (values.suite?.length !== 1 || values.source?.length !== 1 || values.sha?.length !== 1 ||
      (values.json?.length ?? 0) > 1) {
    throw new Error('Supply --suite, --source, and --sha once each. Use --json at most once.');
  }
  return { suite: values.suite[0], source: values.source[0], sha: values.sha[0], json: Boolean(values.json) };
}

export function planCli(args: readonly string[]): string {
  const { suite, source, sha, json } = parseSuiteArgs(args);
  const plan = createPlan(suite, source, sha);
  if (json) return JSON.stringify(plan, null, 2);
  return [
    `Suite: ${plan.suiteId}`,
    `Source repository: ${plan.source.repository}`,
    `Source path: ${JSON.stringify(plan.source.path)}`,
    `Source SHA: ${plan.source.sha}`,
    `Execution command: ${[plan.command.executable, ...plan.command.args].join(' ')}`,
    `Planned workspace (${plan.workspace.isolation}, relative to QEP): ${plan.workspace.path}`,
    `Database required: ${plan.requirements.database ? 'yes' : 'no'}`,
    `Docker required: ${plan.requirements.docker ? 'yes' : 'no'}`,
    `Future artifacts (relative to QEP): ${plan.artifacts.path}`,
  ].join('\n');
}
