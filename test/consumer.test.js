import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { auditedDgiSha } from '../dist/suite-catalog.js';
import { files, integrity, manifest, tar } from './fixtures/clu-archive.js';
import { assertRejected, fixture, snapshot } from './git-fixture.js';

const cliNpm = realpathSync(join(dirname(process.execPath), 'npm'));
const npmVersion = JSON.parse(readFileSync(join(dirname(cliNpm), '../package.json'))).version;
const hash = value => createHash('sha256').update(value).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const localClu = 'qep-clu-candidate.tgz';
const install = ['ci', '--ignore-scripts', '--include=dev'];
const dgiCommands = [
  install,
  ['run', 'typecheck', '-w', 'frontend'],
  ['run', 'build', '-w', 'frontend', '--', '--mode', 'quality'],
  ['run', 'test:frontend'],
];

function setup(t, options = {}) {
  const f = fixture(t, manifest, 'consumer');
  const root = { name: 'delivery-geo-intelligence', private: true, workspaces: ['frontend', 'backend'],
    scripts: { 'test:frontend': 'npm test -w frontend', build: 'exit 98', 'test:backend:integration': 'exit 98' } };
  const dgi = fixture(t, root);
  const frontend = { name: 'frontend', version: '1.0.0', private: true, type: 'module',
    scripts: { test: 'node ../scripts/allure/run.mjs frontend unit run', typecheck: 'tsc --noEmit',
      build: options.unapproved ? 'vite build && npm run test:backend:integration' : 'tsc --noEmit && vite build' },
    dependencies: { [manifest.name]: manifest.version, react: '19.0.0' },
    devDependencies: { typescript: '1.0.0', vite: '1.0.0', vitest: '1.0.0' } };
  const backend = { name: 'backend', version: '1.0.0', private: true, scripts: { test: 'exit 98' } };
  const tools = {
    tsc: `const { existsSync } = require('node:fs');
      if (process.argv[2] !== '--noEmit') process.exit(96);
      if (existsSync('../${localClu}') && process.env.NODE_ENV === 'test') process.exit(${options.candidateTypecheck ?? 0});`,
    vite: `const { mkdirSync, existsSync } = require('node:fs');
      if (process.argv[2] !== 'build') process.exit(96);
      if (existsSync('../backend')) {
        if (process.env.NODE_ENV !== 'production' || process.argv.slice(3).join(' ') !== '--mode quality') process.exit(96);
        if (existsSync('../${localClu}')) process.exitCode = ${options.candidateBuild ?? 0};
      }
      mkdirSync('node_modules/.vite-temp', { recursive: true });
      mkdirSync('dist');`,
    vitest: `require('node:fs').mkdirSync('node_modules/.vite/vitest', { recursive: true });
      console.log('Tests  1 passed (1)'); process.exitCode = ${options.producerExit ?? 0};`,
  };
  const registry = join(f.temp, 'registry');
  mkdirSync(registry);
  function registryEntry(pkg, members = []) {
    const { name, version, bin, peerDependencies } = pkg;
    const bytes = tar([{ path: 'package/package.json', body: JSON.stringify(pkg) }, ...members]);
    const filename = name.split('/').at(-1) + '-' + version + '.tgz';
    const sri = integrity(bytes);
    writeFileSync(join(registry, filename), bytes);
    return { version, ...(bin ? { bin } : {}), ...(peerDependencies ? { peerDependencies } : {}),
      resolved: 'https://registry.npmjs.org/' + name + '/-/' + filename, integrity: sri };
  }
  const react = registryEntry({ name: 'react', version: '19.0.0', main: './index.js' },
    [{ path: 'package/index.js', body: 'module.exports = {};' }]);
  const toolEntry = (name, binName, version) => registryEntry({ name, version, bin: { [binName]: 'cli.cjs' } },
    [{ path: 'package/cli.cjs', mode: 0o755, body: '#!/usr/bin/env node\n' + tools[binName] }]);
  const tsc = toolEntry('typescript', 'tsc', frontend.devDependencies.typescript);
  const vite = toolEntry('vite', 'vite', frontend.devDependencies.vite);
  const vitest = toolEntry('vitest', 'vitest', frontend.devDependencies.vitest);
  const published = registryEntry(manifest, Object.entries(files).filter(([name]) => name !== 'package.json')
    .map(([name, body]) => ({ path: 'package/' + name, body: name === 'dist/index.js' ? body.replace("'button'", "'select'") : body })));
  const cluEntries = { 'node_modules/react': react, 'node_modules/vite': vite, 'node_modules/vitest': vitest };
  const dgiEntries = { ...cluEntries, 'node_modules/typescript': tsc, ['node_modules/' + manifest.name]: published };

  writeFileSync(join(f.source, '.gitignore'), '.env\nnode_modules/\ndist/\n');
  writeJson(join(f.source, 'package-lock.json'), { name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': { name: manifest.name, version: manifest.version, devDependencies: manifest.devDependencies,
      peerDependencies: manifest.peerDependencies }, ...cluEntries } });
  for (const path of ['README.md', 'LICENSE']) writeFileSync(join(f.source, path), files[path]);
  mkdirSync(join(f.source, 'scripts'));
  const dist = Object.entries(files).filter(([path]) => path.startsWith('dist/'));
  writeFileSync(join(f.source, 'scripts/build-types.mjs'), 'import {writeFileSync} from "node:fs";\n' +
    'for (const [path, text] of ' + JSON.stringify(dist) + ') writeFileSync(path, text);\n');

  for (const pkg of [frontend, backend]) {
    mkdirSync(join(dgi.source, pkg.name));
    writeJson(join(dgi.source, pkg.name, 'package.json'), pkg);
  }
  writeJson(join(dgi.source, 'package-lock.json'), { name: root.name, lockfileVersion: 3, packages: {
    '': { name: root.name, workspaces: root.workspaces },
    frontend: { version: frontend.version, dependencies: frontend.dependencies, devDependencies: frontend.devDependencies },
    backend: { version: backend.version },
    'node_modules/frontend': { resolved: 'frontend', link: true },
    'node_modules/backend': { resolved: 'backend', link: true },
    ...dgiEntries,
  } });
  const marker = join(f.temp, 'test-started');
  mkdirSync(join(dgi.source, 'scripts', 'allure'), { recursive: true });
  writeFileSync(join(dgi.source, 'scripts/allure/run.mjs'), `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { createHash } from 'node:crypto';
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    assert.deepEqual(process.argv.slice(2), ['frontend', 'unit', 'run']);
    const sha = readFileSync('../.git/HEAD', 'utf8').trim();
    const candidate = existsSync('../${localClu}');
    const exit = candidate ? ${options.candidateExit ?? 0} : ${options.baselineExit ?? 0};
    const mode = candidate ? ${JSON.stringify(options.candidateMode ?? 'normal')} : 'normal';
    const hash = value => createHash('sha256').update(value).digest('hex');
    if (mode === 'hang') {
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
      await new Promise(resolve => child.once('spawn', resolve));
      writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      setInterval(() => {}, 1000);
    } else {
      mkdirSync('node_modules/.vite/vitest', { recursive: true });
      const counts = {};
      const files = {};
      const dir = '../artifacts/allure-results/frontend/unit';
      if (mode !== 'missing') {
        mkdirSync(dir, { recursive: true });
        for (let index = 0; index < (mode === 'different-count' ? 2 : 1); index++) {
          const now = Date.now();
          const uuid = hash(sha + index);
          const status = exit ? 'failed' : 'passed';
          const historyId = hash('case ' + index + (mode === 'different-case' ? ' changed' : ''));
          const record = JSON.stringify({ name: 'fixture', status, steps: [], attachments: [], start: now, stop: now,
            uuid, fullName: 'fixture', historyId, stage: 'finished',
            labels: [{ name: 'layer', value: 'frontend' }, { name: 'execution', value: 'unit' }] });
          const filename = uuid + '-result.json';
          writeFileSync(dir + '/' + filename, record);
          files[filename] = hash(record);
          counts[status] = (counts[status] ?? 0) + 1;
        }
        writeFileSync(dir + '/dgi-manifest.json', JSON.stringify({ schemaVersion: 1, commit: sha, branch: 'unknown',
          ciRun: 'local', runtime: process.version, environment: 'local', layer: 'frontend', execution: 'unit',
          dataset: 'synthetic-only-v1', testExitCode: exit, counts, auditedAttachments: 0, omittedAttachments: 0, files }));
      }
      const footer = mode === 'conflicting-count' ? { passed: 2 } : mode === 'missing' ? { passed: 1 } : counts;
      console.log('Allure audited frontend/unit: ' + JSON.stringify(footer));
      process.exitCode = exit;
    }
  `);
  const commit = (fixture, origin) => {
    fixture.git('add', '-A');
    fixture.git('-c', 'user.name=QE Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Consumer fixture');
    fixture.git('remote', 'add', 'origin', origin);
    return fixture.git('rev-parse', 'HEAD');
  };
  const cluSha = commit(f, 'https://github.com/Shaobangzhu/react-clu-component-lib.git');
  const dgiSha = commit(dgi, 'https://github.com/Shaobangzhu/delivery-geo-intelligence.git');
  // Only the copied fixture CLI trusts the synthetic DGI revision.
  const catalog = join(f.cwd, 'dist/suite-catalog.js');
  writeFileSync(catalog, readFileSync(catalog, 'utf8').replace(auditedDgiSha, dgiSha));
  const log = join(f.temp, 'npm.jsonl');
  const dependencyTarballs = readdirSync(registry).map(name => join(registry, name));

  // Seed npm's content-addressable cache with synthetic tarballs. Real npm
  // performs offline lockfile installs and dispatches the reviewed scripts.
  writeFileSync(join(f.temp, 'npm/bin/npm-cli.js'), `
    const assert = require('node:assert/strict');
    const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
    const { createRequire } = require('node:module');
    const { join } = require('node:path');
    const { spawnSync } = require('node:child_process');
    const args = process.argv.slice(2);
    const cwd = process.cwd();
    const realNpm = ${JSON.stringify(cliNpm)};
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd, home: process.env.HOME }) + '\\n');
    assert.equal(process.env.QEP_SYNTHETIC_CREDENTIAL, undefined);
    assert.equal(process.env.npm_config_ignore_scripts, 'true');
    assert.equal(existsSync('.env'), false);
    assert.equal(readFileSync('.git/HEAD', 'utf8').trim(),
      JSON.parse(readFileSync('package.json')).name === 'delivery-geo-intelligence' ? ${JSON.stringify(dgiSha)} : ${JSON.stringify(cluSha)});
    (async () => {
      const ci = args[0] === 'ci';
      if (ci) {
        assert.deepEqual(args, ${JSON.stringify(install)});
        const cache = createRequire(realNpm)('cacache');
        for (const tarball of ${JSON.stringify(dependencyTarballs)}) {
          await cache.put(join(process.env.npm_config_cache, '_cacache'), tarball, readFileSync(tarball));
        }
        args.push('--offline');
      }
      const result = spawnSync(process.execPath, [realNpm, ...args], { stdio: 'inherit' });
      if (${Boolean(options.lockMismatch)} && ci && result.status === 0 && existsSync(${JSON.stringify(localClu)})) {
        const path = 'node_modules/.package-lock.json';
        const lock = JSON.parse(readFileSync(path));
        lock.packages[${JSON.stringify('node_modules/' + manifest.name)}].integrity = 'bad';
        writeFileSync(path, JSON.stringify(lock));
      }
      process.exitCode = result.status ?? 97;
    })().catch(error => { console.error(error); process.exitCode = 97; });
  `);
  writeJson(join(f.temp, 'npm/package.json'), { name: 'npm', version: npmVersion });
  f.env.QEP_SYNTHETIC_CREDENTIAL = 'excluded fixture variable';
  const selectors = ['--clu-source', f.source, '--clu-sha', cluSha, '--dgi-source', dgi.source, '--dgi-sha', dgiSha];
  const execution = ['run', ...selectors, '--execute', '--install-deps'];
  const gate = join(f.cwd, '.local', 'consumer-gate');
  return { f, dgi, cluSha, dgiSha, published, gate, selectors, marker,
    execute: (...extra) => f.invoke([...execution, ...extra]),
    spawn: (...extra) => spawn(process.execPath, [join(f.cwd, 'dist/cli.js'), 'consumer', ...execution, ...extra],
      { cwd: f.temp, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] }),
    steps: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

function evidence(response, exitCode) {
  assert.equal(response.status, exitCode, response.stderr);
  const summary = JSON.parse(exitCode === 0 ? response.stdout : response.stderr);
  const { summaryPath, ...retained } = summary;
  assert.deepEqual(readJson(summaryPath), retained);
  assert.equal(existsSync(join(dirname(summaryPath), 'work')), false);
  return summary;
}

test('plan defaults to read-only and execution options, origins and exact selectors are enforced', t => {
  const { f, dgi, selectors, gate, steps } = setup(t);
  const before = [snapshot(f.source), snapshot(dgi.source)];
  for (const subcommand of ['plan', 'run']) {
    const response = f.invoke([subcommand, ...selectors]);
    assert.equal(response.status, 0, response.stderr);
    const plan = JSON.parse(response.stdout);
    assert.equal(plan.mode, 'plan');
    assert.deepEqual(plan.stages.map(stage => stage.name), ['clu', 'baseline', 'candidate', 'compare']);
    assert.deepEqual(plan.stages[1].commands, dgiCommands);
  }
  assertRejected(f.invoke(['run', ...selectors, '--execute']), /requires --install-deps/);
  assertRejected(f.invoke(['run', ...selectors, '--install-deps']), /requires? consumer run --execute/);
  assertRejected(f.invoke(['plan', ...selectors, '--execute', '--install-deps']), /requires? consumer run --execute/);
  assertRejected(f.invoke(['run', ...selectors, '--execute', '--install-deps', '--command', 'npm run build']), /Unknown option/);
  assertRejected(f.invoke(['plan', ...selectors.slice(0, -1), '1234']), /40 hexadecimal/);
  assert.equal(existsSync(gate), false);
  assert.deepEqual(steps(), []);
  assert.deepEqual([snapshot(f.source), snapshot(dgi.source)], before);
  dgi.git('remote', 'set-url', 'origin', 'https://github.com/unapproved/delivery-geo-intelligence.git');
  assertRejected(f.invoke(['plan', ...selectors]), /approved DGI repository/);
});

test('uses approved commands in order, verifies both dependency resolutions and never replaces prior evidence', t => {
  const rig = setup(t);
  const before = [snapshot(rig.f.source), snapshot(rig.dgi.source)];
  const first = evidence(rig.execute(), 0);
  assert.equal(first.status, 'PASS');
  assert.equal(first.sources.clu.sha, rig.cluSha);
  assert.equal(first.sources.dgi.sha, rig.dgiSha);
  const { baseline, candidate } = first.stages;
  assert.deepEqual(baseline.tests, candidate.tests);
  assert.equal(baseline.tests.counts.passed, 1);
  assert.equal(baseline.dependencies.clu.integrity, rig.published.integrity);
  assert.equal(candidate.dependencies.clu.integrity, first.producer.integrity);
  assert.match(candidate.dependencies.installed.react, /^node_modules\/react\//);
  assert.ok(baseline.dependencies.verified && candidate.dependencies.verified);
  assert.notEqual(baseline.dependencies.lockSha256, candidate.dependencies.lockSha256);
  const tarball = readFileSync(join(dirname(first.summaryPath), first.producer.archive));
  assert.equal(integrity(tarball), first.producer.integrity);
  assert.equal(hash(tarball), first.producer.sha256);
  const steps = rig.steps();
  const cluSteps = steps.slice(0, 5);
  const baselineSteps = steps.slice(5, 9);
  const candidateSteps = steps.slice(9);
  assert.deepEqual(cluSteps.map(step => step.args.slice(0, 4)),
    [['--version'], install, ['test', '--ignore-scripts'], ['run', 'build', '--ignore-scripts'],
      ['pack', '--ignore-scripts', '--json', '--pack-destination']]);
  assert.deepEqual(baselineSteps.map(step => step.args), dgiCommands);
  assert.deepEqual(candidateSteps.map(step => step.args), dgiCommands);
  assert.equal(new Set(steps.map(step => step.cwd)).size, 3);
  assert.equal(new Set(steps.map(step => step.home)).size, 3);
  const second = evidence(rig.execute(), 0);
  assert.notEqual(first.evaluationId, second.evaluationId);
  assert.equal(readJson(first.summaryPath).evaluationId, first.evaluationId);
  assert.deepEqual(readFileSync(join(dirname(first.summaryPath), first.producer.archive)), tarball);
  assert.deepEqual([snapshot(rig.f.source), snapshot(rig.dgi.source)], before);
});

for (const [name, options, exitCode, expected] of [
  ['candidate test failure', { candidateExit: 37 }, 37, 'REGRESSION'],
  ['both test suites fail', { baselineExit: 23, candidateExit: 37 }, 23, 'BASELINE_FAILED'],
  ['candidate typecheck and build failure', { candidateTypecheck: 19, candidateBuild: 27 }, 19, 'REGRESSION'],
  ['missing test files despite positive stdout', { candidateMode: 'missing' }, 1, 'BLOCKED'],
  ['test evidence contradicts the console count', { candidateMode: 'conflicting-count' }, 1, 'BLOCKED'],
  ['different test count', { candidateMode: 'different-count' }, 1, 'REGRESSION'],
  ['different test case with the same count', { candidateMode: 'different-case' }, 1, 'REGRESSION'],
  ['installed candidate lock mismatch', { lockMismatch: true }, 2, 'BLOCKED'],
  ['producer test failure', { producerExit: 17 }, 17, 'PRODUCER_FAILED'],
]) {
  test('reports ' + name, t => {
    const rig = setup(t, options);
    const report = evidence(rig.execute(), exitCode);
    assert.equal(report.status, expected);
    const { baseline, candidate } = report.stages;
    if (options.baselineExit) {
      assert.equal(baseline.steps.find(step => step.name === 'test').exitCode, options.baselineExit);
      assert.equal(baseline.tests.counts.failed, 1);
    }
    if (options.candidateExit) {
      assert.equal(candidate.steps.find(step => step.name === 'test').exitCode, options.candidateExit);
      assert.equal(candidate.tests.counts.failed, 1);
    }
    if (options.candidateTypecheck) {
      assert.equal(candidate.steps.find(step => step.name === 'typecheck').exitCode, options.candidateTypecheck);
      assert.equal(candidate.steps.find(step => step.name === 'build').exitCode, options.candidateBuild);
      assert.equal(candidate.steps.find(step => step.name === 'test').exitCode, 0);
    }
    if (options.candidateMode === 'missing') {
      assert.equal(candidate.steps.find(step => step.name === 'test').failureCategory, 'missing-evidence');
      assert.equal(candidate.tests, undefined);
    }
    if (options.candidateMode === 'conflicting-count') {
      assert.equal(candidate.steps.find(step => step.name === 'test').failureCategory, 'failed-evidence');
      assert.equal(candidate.tests.counts.passed, 1);
    }
    if (options.producerExit) {
      assert.equal(report.stopped.step.name, 'test');
      assert.equal(report.producer, undefined);
      assert.deepEqual(baseline.steps, []);
      assert.deepEqual(candidate.steps, []);
    }
    if (options.lockMismatch) {
      assert.equal(report.stopped.step.name, 'candidate-identity');
      assert.equal(candidate.dependencies.verified, false);
      assert.equal(candidate.steps.some(step => step.name === 'typecheck'), false);
    }
  });
}

test('rejects an unapproved DGI script before any npm command or workspace', t => {
  const rig = setup(t, { unapproved: true });
  assertRejected(rig.execute(), /unsupported-profile/);
  assert.deepEqual(rig.steps(), []);
  assert.equal(existsSync(rig.gate), false);
});

function assertStopped(marker) {
  const pid = readFileSync(marker, 'utf8');
  try { assert.match(readFileSync('/proc/' + pid + '/stat', 'utf8'), /\) [ZX] /); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

test('times out and terminates the entire active process group', t => {
  const rig = setup(t, { candidateMode: 'hang' });
  const report = evidence(rig.execute('--timeout-ms', '3000'), 124);
  assert.equal(report.status, 'TIMEOUT');
  assert.equal(report.stopped.stage, 'candidate');
  assert.equal(report.stopped.step.name, 'test');
  assertStopped(rig.marker);
  assert.equal(existsSync(join(rig.gate, 'execution.lock')), false);
});

test('rejects concurrent execution, propagates cancellation and releases its own lock', { timeout: 30000 }, async t => {
  const rig = setup(t, { candidateMode: 'hang' });
  const process = rig.spawn();
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGTERM'); });
  let stdout = '';
  let stderr = '';
  process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  process.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(process, 'close');
  for (let attempt = 0; !existsSync(rig.marker) && process.exitCode === null && attempt < 400; attempt++) await delay(25);
  assert.ok(existsSync(rig.marker), stderr || 'fixture did not reach candidate test');
  const reservations = readdirSync(rig.gate);
  assertRejected(rig.execute(), /Runtime locked by another execution/);
  assert.deepEqual(readdirSync(rig.gate), reservations);
  process.kill('SIGTERM');
  const [status] = await closed;
  const report = evidence({ status, stdout, stderr }, 143);
  assert.equal(report.status, 'CANCELLED');
  assert.equal(report.stopped.stage, 'candidate');
  assertStopped(rig.marker);
  assert.equal(existsSync(join(rig.gate, 'execution.lock')), false);
});
