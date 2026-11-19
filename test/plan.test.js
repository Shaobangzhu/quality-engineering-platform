import assert from 'node:assert/strict';
import { readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertRejected, clu, dgi, fixture, snapshot } from './git-fixture.js';

test('DGI JSON plans expose fixed commands and locations without modifying the source or workspace', (t) => {
  const { source, sha, cwd, git, plan, env } = fixture(t);
  git('config', 'core.fsmonitor', 'touch unexpectedly-ran-fsmonitor');
  env.GIT_INDEX_FILE = join(source, 'invalid-index');
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
  env.GIT_CONFIG_VALUE_0 = 'touch unexpectedly-ran-fsmonitor';
  const before = snapshot(source);

  for (const [suiteId, script] of [
    ['dgi-backend-unit', 'test:backend:unit'],
    ['dgi-frontend-unit', 'test:frontend'],
  ]) {
    const result = plan({ suite: suiteId, commit: sha.toUpperCase() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      suiteId,
      source: { repository: dgi.name, path: source, sha },
      command: { executable: 'npm', args: ['run', script] },
      workspace: { isolation: 'per-run', path: '.local/runs/<run-id>/workspace' },
      requirements: { database: false, docker: false },
      artifacts: { path: `reports/${suiteId}/${sha}/<run-id>` },
    });
  }
  assert.deepEqual(snapshot(source), before);
  assert.deepEqual(readdirSync(cwd), []);
});

test('CLU plans target npm test and accept an absolute path alias to the Git root', (t) => {
  const { source, sha, cwd, plan } = fixture(t, {
    ...clu, engines: { node: '^22.23.4', npm: '>=10.9.0 <11' },
  });
  const alias = join(cwd, 'clu-checkout');
  symlinkSync(source, alias);
  const result = plan({ suite: 'clu-unit', path: alias });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.source, { repository: clu.name, path: source, sha });
  assert.deepEqual(json.command, { executable: 'npm', args: ['test'] });

  const human = plan({ suite: 'clu-unit', extra: [] });
  assert.equal(human.status, 0, human.stderr);
  for (const value of ['clu-unit', clu.name, sha, 'npm test', 'per-run',
    'Database required: no', 'Docker required: no', 'reports/']) {
    assert.ok(human.stdout.includes(value), value);
  }
});

test('rejects unknown suites, invalid SHAs, and HEAD mismatches', (t) => {
  const { plan } = fixture(t);
  assertRejected(plan({ suite: 'custom' }), /Unknown suite/);
  assertRejected(plan({ commit: 'z'.repeat(40) }), /40 hexadecimal characters/);
  assertRejected(plan({ commit: '0'.repeat(40) }), /HEAD does not match/);
});

test('rejects missing, relative, non-directory, and non-root paths', (t) => {
  const { source, cwd, plan } = fixture(t);
  assertRejected(plan({ path: 'relative' }), /must be absolute/);
  assertRejected(plan({ path: join(source, 'missing') }), /existing directory/);
  assertRejected(plan({ path: join(source, 'package.json') }), /existing directory/);
  assertRejected(plan({ path: join(source, '.git') }), /root of a Git checkout/);
  assertRejected(plan({ path: cwd }), /root of a Git checkout/);
});

test('rejects wrong repository identities and missing npm scripts', (t) => {
  const wrong = fixture(t, clu);
  assertRejected(wrong.plan(), /name must be "delivery-geo-intelligence"/);
  const missing = fixture(t, { ...dgi, scripts: { 'test:frontend': 'exit 99' } });
  assertRejected(missing.plan(), /must define the npm script "test:backend:unit"/);
});

test('rejects unstaged, staged, and untracked changes without writing to the source index', (t) => {
  const { source, git, plan } = fixture(t);
  const manifest = join(source, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...dgi, description: 'changed' }));
  const before = snapshot(source);
  assertRejected(plan(), /working tree is dirty/);
  assert.deepEqual(snapshot(source), before);
  git('add', 'package.json');
  assertRejected(plan(), /working tree is dirty/);
  git('restore', '--source=HEAD', '--staged', '--worktree', 'package.json');
  writeFileSync(join(source, 'untracked'), '');
  assertRejected(plan(), /working tree is dirty/);
});

test('rejects arbitrary commands and duplicate selectors', (t) => {
  const { plan } = fixture(t);
  assertRejected(plan({ extra: ['--command', 'touch sentinel'] }), /Unknown option/);
  assertRejected(plan({ extra: ['--', 'touch sentinel'] }), /Unexpected argument/);
  assertRejected(plan({ extra: ['--suite', 'clu-unit'] }), /once each/);
});

test('rejects incompatible Node and npm engines', (t) => {
  for (const runtime of ['node', 'npm']) {
    const { plan } = fixture(t, { ...dgi, engines: { [runtime]: '>=999' } });
    assertRejected(plan(), new RegExp(`Installed ${runtime} does not satisfy the source`));
  }
});

test('rejects symlinked source manifests and Git configuration includes', (t) => {
  const { source, git, plan } = fixture(t);
  const manifest = join(source, 'package.json');
  rmSync(manifest);
  symlinkSync('.env', manifest);
  git('add', 'package.json');
  git('-c', 'user.name=QE Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Link');
  const commit = git('rev-parse', 'HEAD');
  assertRejected(plan({ commit }), /regular JSON manifest/);
  git('config', 'include.path', '../.env');
  assertRejected(plan({ commit }), /uses includes/);
});
