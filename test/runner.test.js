import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { auditedCluSha } from '../dist/suite-catalog.js';
import { runProcess } from '../dist/run-process.js';
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
  for (const key of ['DATABASE_URL', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'npm_config_bad', 'NODE_OPTIONS', 'QEP_REPORTING'])
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
  Object.assign(f.env, { PATH: process.env.PATH, QEP_REPORTING: '1', DATABASE_URL: 'synthetic', NPM_TOKEN: 'synthetic',
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
  for (const extra of [['--clu-junit'], ['--execute', '--clu-junit'], ['--install-deps'], ['--timeout-ms', '0'], ['--timeout-ms', '1800001'], ['--execute', '--execute']]) {
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

test('opt-in reporting is scoped to the reviewed test child and the new run can be collected', t => {
  const f = setup(t, undefined, { 'package-lock.json': JSON.stringify(lockfile) });
  // Give only this disposable QEP installation its synthetic reviewed revision.
  const catalog = join(f.cwd, 'dist/suite-catalog.js');
  writeFileSync(catalog, readFileSync(catalog, 'utf8').replace(auditedCluSha, f.sha));
  fakeNpm(f, `
    const assert = require('node:assert/strict');
    const args = process.argv.slice(2);
    if (args[0] === 'ci') {
      assert.deepEqual(args, ['ci', '--ignore-scripts', '--include=dev']);
      assert.equal(process.env.QEP_REPORTING, undefined);
    } else {
      assert.deepEqual(args, ['test']);
      assert.equal(process.env.QEP_REPORTING, '1');
      require('node:fs').writeFileSync('artifacts/qep/unit.xml', '<testsuite tests="1"><testcase name="unit"/></testsuite>');
      console.log('Tests  1 passed (1)');
    }
  `);
  const data = summary(f, f.execute('--install-deps', '--clu-junit'), 0, 'PASS', null);
  for (const action of ['collect', 'verify']) {
    const output = execFileSync(process.execPath, [join(f.cwd, 'dist/cli.js'), 'results', action, '--run-id', data.runId],
      { encoding: 'utf8' });
    assert.equal(JSON.parse(output).runId, data.runId);
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

test('controlled child environment disables color and preserves its restricted policy', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'qe-child-env-'));
  t.after(() => rmSync(cwd, { recursive: true }));
  const policy = new URL('../dist/run-policy.js', import.meta.url).href;
  const body = `import { writeSync } from 'node:fs';
    import { childEnvironment } from ${JSON.stringify(policy)};
    const env = childEnvironment(process.argv[1]);
    writeSync(1, JSON.stringify({ env, hasForceColor: Object.hasOwn(env, 'FORCE_COLOR') }));`;
  const inherited = {
    FORCE_COLOR: '2', CI: 'false', PATH: '/synthetic-bin', HOME: '/synthetic-home',
    OPENAI_API_KEY: 'synthetic-key', QEP_UNAPPROVED_ENV: 'synthetic-value',
    npm_config_userconfig: '/synthetic-npmrc',
  };
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', body, cwd],
    { env: inherited });
  const { env, hasForceColor } = JSON.parse(stdout);
  await t.test('explicitly sets NO_COLOR', () => assert.equal(env.NO_COLOR, '1'));
  await t.test('omits FORCE_COLOR even when inherited', () => assert.equal(hasForceColor, false));
  await t.test('retains only approved settings apart from the color settings', () => {
    const { NO_COLOR, FORCE_COLOR, ...restricted } = env;
    const home = join(cwd, 'home');
    assert.deepEqual(restricted, {
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: home, TMPDIR: join(cwd, 'tmp'), CI: 'true', TZ: 'UTC', NODE_ENV: 'test',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '',
      npm_config_userconfig: join(home, '.npmrc'), npm_config_globalconfig: '/dev/null',
      npm_config_cache: join(home, '.npm'), npm_config_logs_max: '0',
      npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
      npm_config_ignore_scripts: 'true',
    });
  });
});

test('runProcess decides standard Vitest outcomes from evidence and child exit', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'qe-standard-evidence-'));
  t.after(() => rmSync(cwd, { recursive: true }));
  const plainPass = 'Tests  25 passed (25)';
  const coloredPass = '\x1b[32m' + plainPass + '\x1b[0m';
  const coloredFailure = 'Tests  \x1b[31m1 failed\x1b[39m | 24 passed (25)';
  const failedFiles = 'Test Files  1 failed | 1 passed (2)';
  const pass = { status: 'PASS', exitCode: 0, cliCode: 0, failureCategory: null };
  const failedEvidence = { status: 'FAIL', exitCode: 0, cliCode: 1, failureCategory: 'failed-evidence' };
  const missing = { ...failedEvidence, failureCategory: 'missing-evidence' };
  const nonzero = { ...failedEvidence, exitCode: 23, cliCode: 23, failureCategory: 'exit-nonzero' };
  for (const [name, stdout, stderr, expected] of [
    ['colored positive evidence and exit zero', coloredPass, '', pass],
    ['confirmed colored failed summary and exit zero', coloredFailure, '', failedEvidence],
    ['positive stdout and colored failure stderr', plainPass, coloredFailure, failedEvidence],
    ['independent review failed files and colored positive tests at exit zero',
      failedFiles + '\n\x1b[32mTests  24 passed (24)\x1b[0m', '', failedEvidence],
    ['positive stdout and failed files on stderr at exit zero', plainPass, failedFiles, failedEvidence],
    ['positive evidence and nonzero exit', plainPass, '', nonzero],
    ['exit zero without evidence', 'synthetic log\n', '', missing],
  ]) {
    await t.test(name, async () => {
      const body = `const { writeSync } = require('node:fs');
        writeSync(1, ${JSON.stringify(stdout)});
        writeSync(2, ${JSON.stringify(stderr)});
        process.exitCode = ${expected.exitCode};`;
      const result = await runProcess(process.execPath, ['-e', body], cwd, { CI: 'true' },
        5000, new AbortController().signal, 'standard');
      assert.deepEqual(result, expected);
    });
  }
});

test('runProcess gives timeout, cancellation and background cleanup precedence over Vitest evidence', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'qe-evidence-precedence-'));
  t.after(() => rmSync(cwd, { recursive: true }));
  const positive = "require('node:fs').writeSync(1, 'Tests  1 passed (1)\\n');";
  const hold = "setInterval(() => {}, 1000);";
  const run = (body, signal, timeout = 5000) =>
    runProcess(process.execPath, ['-e', positive + body], cwd, {}, timeout, signal, 'standard');

  await t.test('timeout', async () => {
    const result = await run(hold, new AbortController().signal, 1000);
    assert.deepEqual(result, { status: 'TIMEOUT', failureCategory: 'timeout', exitCode: null, cliCode: 124 });
  });

  await t.test('cancellation after positive evidence', async () => {
    const controller = new AbortController();
    const ready = join(cwd, 'ready');
    const result = run("require('node:fs').writeFileSync('ready', '');" + hold, controller.signal);
    try {
      const deadline = performance.now() + 4000;
      while (!existsSync(ready) && performance.now() < deadline) await delay(25);
      assert.ok(existsSync(ready));
    } finally {
      controller.abort('SIGTERM');
      const outcome = await result;
      assert.deepEqual(outcome, { status: 'CANCELLED', failureCategory: 'cancelled', exitCode: null, cliCode: 143 });
    }
  });

  await t.test('background worker after launcher exit zero', async () => {
    const body = `const worker = require('node:child_process').spawn(process.execPath,
      ['-e', ${JSON.stringify(hold)}], { stdio: 'ignore' });
      worker.once('spawn', () => worker.unref());`;
    const result = await run(body, new AbortController().signal);
    assert.deepEqual(result, { status: 'FAIL', failureCategory: 'background-process', exitCode: 0, cliCode: 1 });
  });
});

test('audited frontend evidence requires stdout and respects pipe and process precedence', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'qe-evidence-'));
  t.after(() => rmSync(cwd, { recursive: true }));
  const footer = 'Allure audited frontend/unit: {"passed":257}';
  const exitZero = { exitCode: 0, status: 'PASS', failureCategory: null, cliCode: 0 };
  const missing = { ...exitZero, status: 'FAIL', failureCategory: 'missing-evidence', cliCode: 1 };
  const failed = { ...missing, failureCategory: 'failed-evidence' };
  const nonzero = { ...failed, exitCode: 23, failureCategory: 'exit-nonzero', cliCode: 23 };
  for (const [name, stdout, stderr, expected, format = 'dgi-frontend-allure'] of [
    ['one valid footer at stdout EOF', footer, '', exitZero],
    ['consistent Vitest summary', footer, 'Tests  257 passed (257)', exitZero],
    ['no evidence', '', '', missing],
    ['footer only on stderr', '', footer, missing],
    ['footer split across pipes', footer.slice(0, 33), footer.slice(33), failed],
    ['footer under the standard profile', footer, '', missing, 'standard'],
    ['duplicate on stdout', footer + '\n' + footer, '', failed],
    ['duplicate across pipes', footer, footer, failed],
    ['conflicting footer on stderr', footer, footer.replace('257', '256'), failed],
    ['malformed footer on stderr', footer, footer.slice(0, -1), failed],
    ['failed Tests summary on stderr', footer, 'Tests  1 failed | 257 passed (258)', failed],
    ['failed Test Files summary on stdout', 'Test Files  1 failed (24)\n' + footer, '', failed],
    ['TAP failure on stderr', footer, 'TAP version 13\nnot ok 1 fixture case', failed],
    ['contradictory complete TAP summary', footer, 'TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0', failed],
    ['contradictory Tests count on stdout', 'Tests: 256 passed, 256 total\n' + footer, '', failed],
    ['contradictory Tests total on stderr', footer, 'Tests  257 passed (258)', failed],
    ['contradictory skipped Tests count', footer, 'Tests  257 passed | 1 skipped (257)', failed],
    ['nonzero exit with valid footer', footer, '', nonzero],
  ]) {
    const body = `const { writeSync } = require('node:fs');
      writeSync(1, ${JSON.stringify(stdout)});
      writeSync(2, ${JSON.stringify(stderr)});
      process.exitCode = ${expected.exitCode};`;
    const outcome = await runProcess(process.execPath, ['-e', body], cwd, { CI: 'true', FORCE_COLOR: '0' },
      5000, new AbortController().signal, format);
    assert.deepEqual(outcome, expected, name);
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
