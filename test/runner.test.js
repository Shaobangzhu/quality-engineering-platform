import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { clu, dgi, fixture, snapshot } from './git-fixture.js';

const script = 'node --test --test-reporter=tap case.test.cjs';
const safeTest = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('node:test')('isolated unit', () => {
  assert.equal(require('node:path').basename(process.cwd()), 'workspace');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.TZ, 'UTC');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.OPENAI_API_KEY, '');
  for (const key of ['DATABASE_URL', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'npm_config_bad', 'NODE_OPTIONS'])
    assert.equal(process.env[key], undefined);
  assert.equal(fs.existsSync('.env'), false);
  fs.writeFileSync('test-ran', 'yes');
});`;
const lockfile = { name: clu.name, lockfileVersion: 3, packages: { '': { name: clu.name } } };

function setup(t, manifest = { ...clu, scripts: { test: script } }, files = {}) {
  const f = fixture(t, manifest, 'run');
  for (const [name, contents] of Object.entries({ 'case.test.cjs': safeTest, ...files })) {
    writeFileSync(join(f.source, name), contents);
  }
  f.git('add', '-A');
  f.git('-c', 'user.name=QE Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic unit');
  const sha = f.git('rev-parse', 'HEAD');
  Object.assign(f.env, { PATH: process.env.PATH, DATABASE_URL: 'synthetic', NPM_TOKEN: 'synthetic',
    OPENAI_API_KEY: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic', npm_config_bad: 'synthetic' });
  const args = ['--suite', 'clu-unit', '--source', f.source, '--sha', sha];
  const runs = join(f.cwd, '.local', 'runs');
  return { ...f, args, sha, runs, execute: (...extra) => f.invoke([...args, '--execute', '--json', ...extra]) };
}

function summary(f, result, code, status, category) {
  assert.equal(result.status, code, result.stderr);
  const data = JSON.parse(code === 0 ? result.stdout : result.stderr);
  assert.deepEqual(Object.keys(data).sort(), ['commitSha', 'durationMs', 'endedAt', 'exitCode', 'failureCategory',
    'phase', 'runId', 'runtimeVersion', 'sourceRepository', 'startedAt', 'status', 'suiteId'].sort());
  assert.equal(data.status, status);
  assert.equal(data.failureCategory, category);
  assert.equal(data.commitSha, f.sha);
  assert.equal(data.runtimeVersion, process.version);
  assert.ok(Number.isInteger(data.durationMs) && data.durationMs >= 0);
  assert.ok(Date.parse(data.startedAt) <= Date.parse(data.endedAt));
  assert.match(data.runId, /^[\da-f-]{36}$/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.runs, data.runId, 'summary.json'))), data);
  return data;
}

function fakeNpm(f, body, shebang = '#!/usr/bin/env node') {
  const bin = join(f.temp, 'npm/bin');
  writeFileSync(join(bin, 'npm-cli.js'), shebang + '\n' + body);
  f.env.PATH = bin + ':' + process.env.PATH;
}

test('run plans without execution, rejects invalid inputs and concurrent lock ownership', t => {
  const f = setup(t);
  assert.equal(f.invoke([...f.args, '--json']).status, 0);
  for (const extra of [['--install-deps'], ['--timeout-ms', '0'], ['--timeout-ms', '1800001'], ['--execute', '--execute']]) {
    assert.equal(f.invoke([...f.args, ...extra]).status, 2);
  }
  for (const [index, replacement] of [[1, 'db-backed'], [5, '0'.repeat(40)]]) {
    const args = [...f.args, '--execute'];
    args[index] = replacement;
    assert.equal(f.invoke(args).status, 2);
  }
  assert.equal(existsSync(f.runs), false);
  mkdirSync(f.runs, { recursive: true, mode: 0o700 });
  symlinkSync(f.source, join(f.runs, 'execution.lock'));
  const before = snapshot(f.source);
  assert.match(f.execute().stderr, /locked/);
  assert.deepEqual(readdirSync(f.runs), ['execution.lock']);
  assert.deepEqual(snapshot(f.source), before);
});

test('all catalog entries run sequentially in disposable checkouts with minimal v0 evidence', t => {
  for (const suite of ['clu-unit', 'dgi-frontend-unit', 'dgi-backend-unit']) {
    const f = setup(t, suite === 'clu-unit' ? undefined :
      { ...dgi, scripts: { 'test:backend:unit': script, 'test:frontend': script } },
    { 'package-lock.json': JSON.stringify(lockfile) });
    f.args[1] = suite;
    const before = snapshot(f.source);
    const result = f.execute(...(suite === 'clu-unit' ? ['--install-deps'] : []));
    const data = summary(f, result, 0, 'PASS', null);
    assert.equal(data.suiteId, suite);
    assert.equal(data.sourceRepository, suite === 'clu-unit' ? clu.name : dgi.name);
    assert.equal(data.phase, 'test');
    assert.equal(data.exitCode, 0);
    assert.ok(existsSync(join(f.runs, data.runId, 'workspace', 'test-ran')));
    assert.deepEqual(snapshot(f.source), before);
  }
});

test('real npm propagates exit 23, zero without test evidence fails, and startup errors are distinct', t => {
  for (const [body, cli, actual, category] of [
    ['process.exit(23);', 23, 23, 'exit-nonzero'], ["console.log('synthetic secret output');", 1, 0, 'missing-evidence'],
  ]) {
    const f = setup(t, { ...clu, scripts: { test: 'node fixture.cjs' } }, { 'fixture.cjs': body });
    assert.equal(summary(f, f.execute(), cli, 'FAIL', category).exitCode, actual);
  }
  const f = setup(t);
  fakeNpm(f, '', '#!/nonexistent-qep-fixture-interpreter');
  assert.equal(summary(f, f.execute(), 2, 'BLOCKED', 'startup').exitCode, null);
});

test('missing dependencies, failed npm ci and install hooks never fall through to test', t => {
  const packages = { ...lockfile.packages,
    'node_modules/missing': { version: '1.0.0', resolved: 'https://registry.npmjs.org/missing/-/missing-1.0.0.tgz',
      integrity: 'sha512-' + 'A'.repeat(86) + '==', hasInstallScript: true } };
  const f = setup(t, { ...clu, scripts: { test: script }, dependencies: { missing: '1.0.0' } },
    { 'package-lock.json': JSON.stringify({ ...lockfile, packages }) });
  const before = snapshot(f.source);
  summary(f, f.execute(), 2, 'BLOCKED', 'dependencies-required');
  fakeNpm(f, `require('node:assert/strict').deepEqual(process.argv.slice(2), ['ci','--ignore-scripts','--include=dev']);
    process.exit(31);`);
  const failed = summary(f, f.execute('--install-deps'), 31, 'FAIL', 'install-failed');
  assert.equal(failed.phase, 'install');
  assert.equal(failed.exitCode, 31);
  assert.deepEqual(snapshot(f.source), before);
  const hook = setup(t, { ...clu, scripts: { test: script, postinstall: 'node hook.js' } },
    { 'package-lock.json': JSON.stringify(lockfile) });
  const blocked = hook.invoke([...hook.args, '--execute', '--install-deps']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED.*separately reviewed lifecycle-script exception/);
});

test('requires declared dependencies inside the new checkout, including after a zero install exit', t => {
  const packages = { ...lockfile.packages,
    'node_modules/sample': { version: '1.0.0', resolved: 'https://registry.npmjs.org/sample/-/sample-1.0.0.tgz',
      integrity: 'sha512-' + 'A'.repeat(86) + '==' } };
  const f = setup(t, { ...clu, scripts: { test: script }, dependencies: { sample: '1.0.0' } },
    { 'package-lock.json': JSON.stringify({ ...lockfile, packages }) });
  fakeNpm(f, 'process.exit(0);');
  summary(f, f.execute('--install-deps'), 2, 'BLOCKED', 'dependencies-required');
  fakeNpm(f, `if (process.argv[2] === 'ci') {
    const fs = require('node:fs');
    fs.mkdirSync('node_modules/sample', { recursive: true });
    fs.writeFileSync('node_modules/sample/package.json', JSON.stringify({ name: 'sample', version: '1.0.0' }));
  } else { console.log('Tests: 1 passed, 1 total'); }`);
  summary(f, f.execute('--install-deps'), 0, 'PASS', null);
});

test('reporter evidence must be complete, positive and consistent across output streams', t => {
  const f = setup(t);
  for (const [stdout, stderr, status, category] of [
    [' Tests  1 passed (1)', '', 0, null],
    ['Tests: 1 passed', '', 1, 'missing-evidence'],
    ['TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n# cancelled 0', '', 1, 'missing-evidence'],
    ['Tests: 1 passed, 1 total', 'Tests: 1 failed, 1 total', 1, 'failed-evidence'],
  ]) {
    fakeNpm(f, 'console.log(' + JSON.stringify(stdout) + '); console.error(' + JSON.stringify(stderr) + ');');
    summary(f, f.execute(), status, status ? 'FAIL' : 'PASS', category);
  }
});

test('blocks unsupported workload commands before spawning npm', t => {
  for (const command of ['docker compose up', 'node --test && sudo anything', 'vitest run --browser', 'node --test db/reset.js']) {
    const f = setup(t, { ...clu, scripts: { test: command } });
    summary(f, f.execute(), 2, 'BLOCKED', 'unsupported-profile');
  }
});

test('rechecks tracked and ignored files after installation before test dispatch', t => {
  for (const name of ['case.test.cjs', '.env']) {
    const f = setup(t, undefined, { 'package-lock.json': JSON.stringify(lockfile) });
    fakeNpm(f, `require('node:fs').writeFileSync('${name}', 'synthetic');`);
    const blocked = summary(f, f.execute('--install-deps'), 2, 'BLOCKED', 'integrity');
    assert.equal(existsSync(join(f.runs, blocked.runId, 'workspace', 'test-ran')), false);
  }
});

function sleeper(f) {
  fakeNpm(f, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', \`
      const fs = require('node:fs');
      for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => fs.writeFileSync('forwarded', signal));
      fs.writeFileSync('ready', String(process.pid));
      setInterval(() => {}, 1000);
    \`], { stdio: 'ignore' });
    grandchild.on('exit', () => process.exit(0));
    setInterval(() => {}, 1000);`);
}

function assertStopped(workspace) {
  const pid = readFileSync(join(workspace, 'ready'), 'utf8');
  const statPath = join('/proc', pid, 'stat');
  try {
    const stat = readFileSync(statPath, 'utf8');
    assert.match(stat.slice(stat.lastIndexOf(')') + 2), /^[ZX] /);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

test('a launcher that exits while a worker remains causes cleanup and a failed run', t => {
  const f = setup(t);
  fakeNpm(f, `
    const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' });
    require('node:fs').writeFileSync('ready', String(worker.pid));
    console.log('Tests: 1 passed, 1 total');
    process.exit(0);`);
  const result = summary(f, f.execute(), 1, 'FAIL', 'background-process');
  assert.equal(result.exitCode, 0);
  assertStopped(join(f.runs, result.runId, 'workspace'));
  assert.equal(existsSync(join(f.runs, 'execution.lock')), false);
});

test('timeout terminates the whole group even when a descendant ignores TERM', t => {
  const f = setup(t);
  sleeper(f);
  const data = summary(f, f.execute('--timeout-ms', '1500'), 124, 'TIMEOUT', 'timeout');
  assert.equal(data.exitCode, null);
  assert.equal(readFileSync(join(f.runs, data.runId, 'workspace', 'forwarded'), 'utf8'), 'SIGTERM');
  assertStopped(join(f.runs, data.runId, 'workspace'));
  assert.ok(data.durationMs < 10000);
  assert.equal(existsSync(join(f.runs, 'execution.lock')), false);
});

test('live execution excludes a second run, forwards cancellation and releases its own lock', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = setup(t);
    sleeper(f);
    const child = spawn(process.execPath, [join(f.cwd, 'dist/cli.js'), 'run', ...f.args, '--execute', '--json', '--timeout-ms', '10000'],
      { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.once('close', resolve));
    try {
      let ready;
      const end = Date.now() + 7000;
      while (Date.now() < end && !ready) {
        await delay(25);
        if (!existsSync(f.runs)) continue;
        const id = readdirSync(f.runs).find(entry => entry !== 'execution.lock');
        if (id && existsSync(join(f.runs, id, 'workspace/ready'))) ready = id;
      }
      assert.ok(ready, stderr);
      const concurrent = f.execute();
      assert.equal(concurrent.status, 2);
      assert.match(concurrent.stderr, /locked/);
      assert.deepEqual(readdirSync(f.runs).sort(), [ready, 'execution.lock'].sort());
      child.kill(signal);
      const data = summary(f, { status: await done, stderr }, signal === 'SIGINT' ? 130 : 143, 'CANCELLED', 'cancelled');
      assert.equal(readFileSync(join(f.runs, data.runId, 'workspace/forwarded'), 'utf8'), signal);
      assertStopped(join(f.runs, data.runId, 'workspace'));
      assert.equal(existsSync(join(f.runs, 'execution.lock')), false);
    } finally {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
      await done;
    }
  }
});
