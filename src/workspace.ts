import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { checkProject, parseSuiteArgs, validateSource } from './plan.js';
import { checkSourceGit, git } from './source-git.js';
import { checkWorkspaceTree } from './workspace-tree.js';

const qepRoot = resolve(import.meta.dirname, '..');
const restricted = ['/home/clu/infra/secrets', '/home/clu/infra/secrets-staging'];

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

function directory(path: string): string {
  if (!isAbsolute(path) || path.split(sep).includes('..') || path.includes('\0')) {
    throw new Error('Workspace inputs require absolute paths without traversal.');
  }
  const canonical = resolve(path);
  if (restricted.some((blocked) => overlaps(canonical, blocked))) throw new Error('Restricted directory.');
  let current: string = sep;
  for (const part of canonical.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('Workspace paths require existing directories without symlinks.');
    }
  }
  return canonical;
}

function runParent(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) {
    throw new Error('Run storage must be an owned directory without symlinks or shared write access.');
  }
  return path;
}

export function validateWorkspacePaths(sourcePath: string, storage: 'runs' | 'consumer-gate' = 'runs') {
  const source = directory(sourcePath);
  const local = join(directory(qepRoot), '.local');
  const runs = join(local, storage);
  if (overlaps(runs, source)) throw new Error('Source and run storage must be disjoint.');

  return { source, local, runs };
}

export function inspectWorkspace(request: Pick<ReturnType<typeof parseSuiteArgs>, 'source' | 'sha' | 'suite'>,
  storage: 'runs' | 'consumer-gate' = 'runs') {
  const { source, local, runs } = validateWorkspacePaths(request.source, storage);
  const { suite, source: provenance } = validateSource(request.suite, source, request.sha, true);
  const { sha } = provenance;
  const originalRef = git(source, ['rev-parse', '--symbolic-full-name', 'HEAD'], 'source HEAD reference');
  checkWorkspaceTree(source, sha, suite.id);

  return { suite, source: provenance, local, runs, originalRef };
}

export function prepareWorkspace(request: Parameters<typeof inspectWorkspace>[0],
  storage: Parameters<typeof inspectWorkspace>[1] = 'runs') {
  const preparation = inspectWorkspace(request, storage);
  initializeWorkspaceStorage(preparation);
  return preparation;
}

export function initializeWorkspaceStorage(preparation: ReturnType<typeof inspectWorkspace>) {
  runParent(preparation.local);
  runParent(preparation.runs);
}

export function reserveWorkspace({ suite, source, runs }: ReturnType<typeof prepareWorkspace>) {
  const runId: string = randomUUID();
  const runPath = join(runs, runId);
  // Exclusive mkdir is the ownership boundary. Any failure leaves prior runs alone.
  mkdirSync(runPath, { mode: 0o700 });
  const workspace = join(runPath, 'workspace');
  return { runId, runPath, workspace, suiteId: suite.id, source };
}

export type Workspace = ReturnType<typeof reserveWorkspace>;

export function verifyWorkspaceSource({ source: { path, sha }, originalRef }: ReturnType<typeof prepareWorkspace>) {
  checkSourceGit(path, sha, true);
  if (git(path, ['rev-parse', '--symbolic-full-name', 'HEAD'], 'source HEAD reference') !== originalRef) {
    throw new Error('Source HEAD reference changed during provisioning.');
  }
}

export function workspaceCloneArgs({ workspace, source: { path, sha } }: Workspace) {
  return ['-c', 'fetch.fsckObjects=true', 'clone', '--template=', '--no-local', '--no-hardlinks',
    '--depth=1', '--no-tags', '--no-checkout', '--revision', sha, '--', path, workspace];
}

export function verifyDetachedWorkspace({ workspace, source: { sha } }: Workspace) {
  const head = git(workspace, ['rev-parse', '--verify', 'HEAD^{commit}'], 'cloned HEAD').trim();
  if (head !== sha ||
      git(workspace, ['rev-parse', '--symbolic-full-name', 'HEAD'], 'workspace reference') !== 'HEAD\n') {
    throw new Error('Workspace HEAD must be detached at the requested SHA.');
  }
  return head;
}

export function checkoutWorkspace(run: Workspace, preparation: ReturnType<typeof prepareWorkspace>) {
  const { workspace, runId, source: { sha } } = run;
  try {
    git('/', workspaceCloneArgs(run), 'local workspace clone', true);
    git(workspace, ['checkout', '--detach', sha, '--'], 'workspace checkout');
    verifyDetachedWorkspace(run);
    git(workspace, ['remote', 'remove', 'origin'], 'workspace remote removal');
    checkProject(workspace, preparation.suite);
    verifyWorkspaceSource(preparation);
  } catch (error) {
    throw new Error(`Run ${runId} failed: ${error instanceof Error ? error.message : 'Unable to provision workspace.'}`);
  }
}

export function workspaceCli(args: readonly string[]): string {
  const request = parseSuiteArgs(args);
  const preparation = prepareWorkspace(request);
  const result = reserveWorkspace(preparation);
  checkoutWorkspace(result, preparation);
  const { runId, workspace, source: { sha } } = result;
  return request.json ? JSON.stringify(result, null, 2) :
    `Run: ${runId}\nWorkspace: ${JSON.stringify(workspace)}\nSource SHA: ${sha}`;
}
