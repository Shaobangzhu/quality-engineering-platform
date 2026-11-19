import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertRejected, clu, fixture, snapshot } from './git-fixture.js';

const setup = (t) => fixture(t, clu, 'workspace');
const provision = (f, options) => f.plan({ suite: 'clu-unit', ...options });
const runs = (f) => join(f.cwd, '.local', 'runs');

function commit(f) {
  f.git('add', '-A');
  f.git('-c', 'user.name=QE Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture update');
  return f.git('rev-parse', 'HEAD');
}

function success(f, options) {
  const result = provision(f, options);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function wrapGit(f, body) {
  const bin = join(f.temp, 'wrappers');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${body}\nexec "${realGit}" "$@"\n`, { mode: 0o700 });
  f.env.PATH = bin + ':' + f.env.PATH;
}

test('provisions independent detached clones of only the specified commit, preserving all source evidence', (t) => {
  const f = setup(t);
  writeFileSync(join(f.source, 'old-only'), 'previous commit only');
  commit(f);
  const oldBlob = f.git('rev-parse', 'HEAD:old-only');
  f.git('rm', '-q', 'old-only');
  writeFileSync(join(f.source, '.gitignore'), '.env*\n!.env.example\nnode_modules\n*.bak\n');
  writeFileSync(join(f.source, '.env.example'), 'SYNTHETIC=\n');
  writeFileSync(join(f.source, '.env.local'), 'fixture');
  writeFileSync(join(f.source, 'local.bak'), 'fixture');
  mkdirSync(join(f.source, 'node_modules'));
  writeFileSync(join(f.source, 'node_modules', 'existing'), 'fixture');
  mkdirSync(join(f.source, 'docs'));
  symlinkSync('../package.json', join(f.source, 'docs', 'manifest'));
  const sha = commit(f);
  f.git('config', 'remote.origin.url', 'https://example.invalid/never-contact');
  const before = snapshot(f.source);
  const one = success(f, { commit: sha.toUpperCase() });
  assert.deepEqual(one.source, { path: f.source, sha, repository: clu.name });
  assert.match(one.runId, /^[\da-f-]{36}$/);
  assert.equal(one.runPath, join(runs(f), one.runId));
  assert.equal(one.workspace, join(one.runPath, 'workspace'));
  assert.deepEqual(readdirSync(one.runPath), ['workspace']);
  assert.equal(lstatSync(one.runPath).mode & 0o777, 0o700);
  const git = (...args) => f.git('-C', one.workspace, ...args);
  assert.equal(git('rev-parse', 'HEAD'), sha);
  assert.equal(git('rev-parse', '--symbolic-full-name', 'HEAD'), 'HEAD');
  assert.equal(git('rev-list', '--all', '--count'), '1');
  assert.equal(git('remote'), '');
  assert.equal(spawnSync('git', ['cat-file', '-e', oldBlob], { cwd: one.workspace }).status, 1);
  assert.deepEqual(readdirSync(one.workspace).sort(), ['.env.example', '.git', '.gitignore', 'docs', 'package.json']);
  assert.equal(readFileSync(join(one.workspace, 'docs', 'manifest'), 'utf8'), JSON.stringify(clu));
  assert.equal(existsSync(join(one.workspace, '.git/objects/info/alternates')), false);
  writeFileSync(join(one.workspace, 'package.json'), 'private to run one');
  const firstRun = snapshot(one.runPath);
  const two = success(f, { commit: sha });
  assert.notEqual(two.runId, one.runId);
  assert.equal(readFileSync(join(two.workspace, 'package.json'), 'utf8'), JSON.stringify(clu));
  assert.deepEqual(snapshot(one.runPath), firstRun);
  assert.deepEqual(snapshot(f.source), before);
});

test('rejects missing selectors, aliases, traversal, restricted paths, overlap, and non-checkouts', (t) => {
  const f = setup(t);
  assertRejected(f.invoke(['--source', f.source]), /Supply --suite/);
  symlinkSync(f.source, join(f.temp, 'alias'));
  for (const path of ['relative', f.source + '/../source with spaces', '/home/clu/infra/secrets',
    '/home/clu/infra/secrets-staging/nested', join(f.temp, 'alias'), join(f.temp, 'missing'),
    join(f.source, 'package.json'), f.cwd, join(f.source, '.git')]) {
    assert.equal(provision(f, { path }).status, 2, path);
  }
  assertRejected(provision(f, { extra: ['--run-id', '../prior'] }), /Unknown option/);
  assert.equal(existsSync(runs(f)), false);
});

test('rejects wrong SHA, identity, and dirty worktrees without reserving a run', (t) => {
  const f = setup(t);
  assertRejected(provision(f, { commit: '0'.repeat(40) }), /HEAD does not match/);
  assertRejected(provision(f, { suite: 'dgi-backend-unit' }), /name must be/);
  writeFileSync(join(f.source, 'changes'), 'untracked');
  assertRejected(provision(f), /working tree is dirty/);
  f.git('add', 'changes');
  assertRejected(provision(f), /working tree is dirty/);
  const sha = commit(f);
  writeFileSync(join(f.source, 'changes'), 'unstaged');
  const before = snapshot(f.source);
  assertRejected(provision(f, { commit: sha }), /working tree is dirty/);
  assert.deepEqual(snapshot(f.source), before);
  assert.equal(existsSync(runs(f)), false);
});

test('rejects tracked private paths before cloning', (t) => {
  for (const name of ['.env', 'app/.env.production', 'auth/credentials.json', '.ssh/config', 'tls/server.key',
    'backups/copy', 'source.bak', 'app/node_modules/library/index.js', '.env.example/nested']) {
    const f = setup(t);
    const path = join(f.source, name);
    mkdirSync(dirname(path), { recursive: true });
    if (name !== '.env') writeFileSync(path, 'fixture');
    if (name === '.env') chmodSync(path, 0o600);
    f.git('add', '-f', '--', name);
    assertRejected(provision(f, { commit: commit(f) }), /private or unsupported path/);
    assert.equal(existsSync(runs(f)), false);
  }
});

test('rejects direct, chained, cyclic, dangling, and absolute symlink targets before transfer', (t) => {
  for (const target of ['../outside', '/home/clu/infra/secrets', 'docs/up/../outside', 'cycle', 'absent', '.git/config']) {
    const f = setup(t);
    mkdirSync(join(f.source, 'docs'));
    symlinkSync('..', join(f.source, 'docs/up'));
    symlinkSync(target, join(f.source, 'cycle'));
    const sha = commit(f);
    assertRejected(provision(f, { commit: sha }), /symlink/);
    assert.equal(existsSync(runs(f)), false);
  }
});

test('rejects symlinked run ancestors and preserves the target', (t) => {
  for (const name of ['.local', '.local/runs']) {
    const f = setup(t);
    const path = join(f.cwd, name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(f.source, path);
    const before = snapshot(f.source);
    assertRejected(provision(f), /Run storage/);
    assert.deepEqual(snapshot(f.source), before);
  }
});

test('exclusive reservation preserves an existing run on ID collision', (t) => {
  const f = setup(t);
  const fixed = '11111111-1111-4111-8111-111111111111';
  const preload = join(f.temp, 'fixed-id.cjs');
  writeFileSync(preload, `require('node:crypto').randomUUID = () => '${fixed}'; require('node:module').syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = '--require=' + preload;
  const first = success(f);
  assert.equal(first.runId, fixed);
  const before = snapshot(first.runPath);
  assertRejected(provision(f), /EEXIST/);
  assert.deepEqual(snapshot(first.runPath), before);
});

test('missing Git and failed local clone preserve source and previous runs', (t) => {
  const f = setup(t);
  const prior = success(f);
  const before = snapshot(prior.runPath);
  const sourceBefore = snapshot(f.source);
  const path = f.env.PATH;
  f.env.PATH = f.temp;
  assertRejected(provision(f), /using Git/);
  f.env.PATH = path;
  wrapGit(f, 'for arg do if [ "$arg" = clone ]; then exit 1; fi; done');
  assertRejected(provision(f), /Run [\da-f-]+ failed: Cannot check local workspace clone/);
  assert.equal(readdirSync(runs(f)).length, 2);
  assert.deepEqual(snapshot(prior.runPath), before);
  assert.deepEqual(snapshot(f.source), sourceBefore);
});

test('refuses external metadata and split indexes before a source Git read can refresh them', (t) => {
  const f = setup(t);
  symlinkSync('/home/clu/infra/secrets-staging', join(f.source, '.git/refs/external'));
  assertRejected(provision(f), /unsupported Git metadata/);
  assert.equal(existsSync(runs(f)), false);

  const split = setup(t);
  split.git('update-index', '--split-index');
  const before = snapshot(split.source);
  assertRejected(provision(split), /Split Git indexes/);
  assert.deepEqual(snapshot(split.source), before);
});

test('verifies cloned package identity independently and detects concurrent source changes', (t) => {
  for (const fault of ['clone identity', 'source dirtiness']) {
    const f = setup(t);
    // The wrapper runs immediately after the real workspace checkout succeeds.
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const mutation = fault === 'clone identity'
      ? 'echo "{}" > "$workspace/package.json"'
      : `touch "${f.source}/concurrent-change"`;
    wrapGit(f, `prev=""
for arg do
  if [ "$prev" = "-C" ]; then workspace="$arg"; fi
  if [ "$arg" = checkout ]; then
    "${realGit}" "$@" || exit 1
    ${mutation}
    exit 0
  fi
  prev="$arg"
done`);
    assertRejected(provision(f), fault === 'clone identity' ? /package.json name must be/ : /working tree is dirty/);
    assert.equal(readdirSync(runs(f)).length, 1);
  }
});
