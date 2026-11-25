import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from '../dist/result-contract-v1.js';
import { auditedCluSha, auditedDgiSha } from '../dist/suite-catalog.js';

const modules = fileURLToPath(new URL('../node_modules', import.meta.url));
const summaryStart = '2026-01-01T00:00:00.000Z';
const privateMarker = 'synthetic-private-diagnostic';
const pass = { status: 'PASS', exitCode: 0, failureCategory: null };
const fail = { status: 'FAIL', exitCode: 1, failureCategory: 'exit-nonzero' };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));

async function installation(t, realGenerator = false) {
  const root = mkdtempSync(join(tmpdir(), 'qep-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  cpSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  if (realGenerator) {
    symlinkSync(modules, join(root, 'node_modules'));
  } else {
    mkdirSync(join(root, 'node_modules'));
    for (const name of ['saxes', 'semver']) symlinkSync(join(modules, name), join(root, 'node_modules', name));
  }
  const reports = join(root, '.local/reports');
  const runs = join(root, '.local/runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const { runCli } = await import(pathToFileURL(join(root, 'dist/run-cli.js')));

  function report(action, ...ids) {
    return runCli(['report', action, ...ids.flatMap(id => ['--run-id', id])]);
  }
  function run(suite = 'clu-unit', outcome = pass, patch = {}, collect = true) {
    const id = randomUUID();
    const directory = join(runs, id);
    const clu = suite === 'clu-unit';
    const summary = {
      runId: id, suiteId: suite, sourceRepository: clu ? '@shaobangzhu/clu-ui' : 'delivery-geo-intelligence',
      commitSha: clu ? auditedCluSha : auditedDgiSha, runtimeVersion: process.version,
      startedAt: summaryStart, endedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000, phase: 'test',
      ...outcome, ...patch,
    };
    const summaryPath = join(directory, 'summary.json');
    let evidence;
    if (clu) {
      const folder = join(directory, 'workspace/artifacts/qep');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeJson(summaryPath, summary);
      const xml = '<testsuite tests="2" skipped="1"><testcase name="' + privateMarker +
        '"/><testcase name="skip"><skipped/></testcase></testsuite>';
      evidence = join(folder, 'unit.xml');
      writeFileSync(evidence, xml);
      writeFileSync(join(directory, 'clu-junit.receipt'), JSON.stringify([sha256(readFileSync(summaryPath)), sha256(xml)]) + '\n');
    } else {
      const layer = suite.split('-')[1];
      const folder = join(directory, 'workspace/artifacts/allure-results', layer, 'unit');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeJson(summaryPath, summary);
      const uuid = sha256(id);
      const name = uuid + '-result.json';
      evidence = join(folder, name);
      writeJson(evidence, {
        uuid, historyId: sha256('synthetic logical case'), name: privateMarker, fullName: privateMarker,
        status: 'passed', stage: 'finished', start: Date.parse(summaryStart), stop: Date.parse(summaryStart) + 5,
        steps: [], attachments: [],
        labels: [{ name: 'suite', value: privateMarker }, { name: 'execution', value: 'unit' }, { name: 'layer', value: layer }],
      });
      writeJson(join(folder, 'dgi-manifest.json'), {
        schemaVersion: 1, layer, execution: 'unit', dataset: 'synthetic-only-v1', commit: auditedDgiSha,
        branch: 'unknown', ciRun: 'local', runtime: summary.runtimeVersion, environment: 'local', testExitCode: summary.exitCode,
        counts: { passed: 1 }, auditedAttachments: 0, omittedAttachments: 0, files: { [name]: sha256(readFileSync(evidence)) },
      });
    }
    if (collect) assert.equal(runCli(['results', 'collect', '--run-id', id]).exitCode, 0);
    return { id, summaryPath, evidence, result: join(directory, 'results-v1/result-v1.json'),
      manifest: join(directory, 'results-v1/manifest-v1.json') };
  }
  function stub(body, real = false) {
    const dir = join(root, 'node_modules/allure');
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'package.json'), { name: 'allure', version: '3.33.0', type: 'module' });
    writeFileSync(join(dir, 'cli.js'), `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      if (process.argv.includes('--version')) {
        console.log('3.33.0');
      } else {
        ${real ? `const generator = spawnSync(process.execPath,
          [${JSON.stringify(join(modules, 'allure/cli.js'))}, ...process.argv.slice(2)]);
          if (generator.status !== 0) process.exit(21);` : ''}
        ${body}
      }
    `);
  }
  return { root, reports, runs, runCli, report, run, stub };
}

function success(response) {
  assert.equal(response.exitCode, 0, response.stderr);
  assert.equal(response.stderr, undefined);
  return JSON.parse(response.stdout);
}

function rejected(response, expected, exitCode = 2) {
  assert.equal(response.exitCode, exitCode, response.stderr);
  assert.equal(response.stdout, undefined);
  assert.match(response.stderr, expected);
  assert.ok(!response.stderr.includes(privateMarker));
}

function snapshot(paths) {
  return paths.map(path => [readFileSync(path), statSync(path, { bigint: true }).ctimeNs]);
}

test('one-run report preserves originals and an identical request reuses verified output', async t => {
  const { root, reports, report, run } = await installation(t, true);
  const input = run();
  const paths = [input.summaryPath, input.evidence, input.result, input.manifest];
  const before = snapshot(paths);
  const plan = success(report('plan', input.id));
  assert.equal(plan.status, 'planned');
  assert.equal(plan.acceptance, 'verified-successful-launch');
  assert.equal(plan.counts.total, 2);
  assert.equal(plan.runs[0].manifestSha256, sha256(before[3][0]));
  assert.equal(plan.reportId, sha256(JSON.stringify(['qep-report-v1', [[input.id, plan.runs[0].manifestSha256]]])));
  rejected(report('verify', input.id), /unavailable report/);
  assert.equal(existsSync(reports), false);
  assert.equal(success(report('build', input.id)).status, 'built');
  const output = join(root, plan.directory);
  const manifestPath = join(output, 'report-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.runs, plan.runs);
  assert.deepEqual(manifest.counts, plan.counts);
  assert.deepEqual(readdirSync(reports), [plan.reportId]);
  assert.equal(statSync(output).mode & 0o777, 0o700);
  const files = manifest.files.map(file => {
    const path = join(output, file.name), data = readFileSync(path);
    assert.equal(file.bytes, data.length);
    assert.equal(file.sha256, sha256(data));
    assert.ok(!data.includes(privateMarker));
    assert.ok(!data.includes('googletagmanager.com'));
    return path;
  });
  const published = snapshot([...files, manifestPath]);
  const cli = childProcess.spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'report', 'verify', '--run-id', input.id], {
    cwd: tmpdir(), encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(success(report('build', input.id)).status, 'reused');
  assert.deepEqual(snapshot([...files, manifestPath]), published);
  assert.deepEqual(snapshot(paths), before);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, policy: 'different-policy' }));
  const corrupted = snapshot([manifestPath]);
  rejected(report('verify', input.id), /manifest or file digests/);
  rejected(report('build', input.id), /manifest or file digests/);
  assert.deepEqual(snapshot([manifestPath]), corrupted);
});

test('three-suite report checks all case counts across audited source identities', async t => {
  const { report, run } = await installation(t, true);
  const ids = [run('dgi-backend-unit').id, run('dgi-frontend-unit').id, run().id];
  const historical = run('clu-unit', fail);
  const before = snapshot([historical.summaryPath, historical.result, historical.manifest]);
  const built = success(report('build', ...ids));
  assert.deepEqual(built.counts, { total: 4, passed: 3, skipped: 1, failed: 0, broken: 0, unknown: 0 });
  assert.deepEqual(built.runs.map(run => run.runId), [...ids].sort());
  assert.equal(success(report('verify', ...ids.toReversed())).reportId, built.reportId);
  assert.equal(success(report('build', ...ids.toReversed())).status, 'reused');
  assert.deepEqual(snapshot([historical.summaryPath, historical.result, historical.manifest]), before);
});

test('two explicitly selected runs of one suite retain both executions of the same cases', async t => {
  const { report, run } = await installation(t, true);
  const ids = [run().id, run().id];
  assert.equal(success(report('build', ...ids)).counts.total, 4);
  assert.equal(success(report('verify', ...ids)).counts.passed, 2);
});

test('rejects malformed, duplicate, unknown and uncollected Run IDs without writes', async t => {
  const { reports, report, run, runCli } = await installation(t);
  const { id } = run();
  const uncollected = run('clu-unit', pass, {}, false);
  for (const action of ['plan', 'build', 'verify']) {
    rejected(report(action, id, id), /Duplicate Run ID/);
    rejected(report(action, '../' + id), /Malformed Run ID/);
    rejected(report(action, randomUUID()), /invalid or missing evidence/);
    rejected(report(action, uncollected.id), /invalid or missing evidence/);
    rejected(runCli(['report', action, '--suite', 'clu-unit']), /explicit --run-id/);
    rejected(runCli(['report', action]), /explicit --run-id/);
  }
  assert.equal(existsSync(reports), false);
  assert.equal(existsSync(uncollected.manifest), false);
});

test('rejects tampered result bytes and wrong manifest digests', async t => {
  const { reports, report, run } = await installation(t);
  const changed = run();
  writeFileSync(changed.result, readFileSync(changed.result, 'utf8') + ' ');
  rejected(report('build', changed.id), /invalid or missing evidence/);
  const wrongHash = run();
  const manifest = JSON.parse(readFileSync(wrongHash.manifest));
  manifest.files[0].sha256 = '0'.repeat(64);
  writeJson(wrongHash.manifest, manifest);
  rejected(report('plan', wrongHash.id), /invalid or missing evidence/);
  assert.equal(existsSync(reports), false);
});

test('rejects mixed source identity and distinguishes verified unsuccessful execution', async t => {
  const { reports, report, run } = await installation(t);
  const good = run('dgi-backend-unit');
  for (const patch of [{ commitSha: auditedCluSha }, { sourceRepository: '@shaobangzhu/clu-ui' }]) {
    const bad = run('dgi-frontend-unit');
    writeJson(bad.summaryPath, { ...JSON.parse(readFileSync(bad.summaryPath)), ...patch });
    rejected(report('build', good.id, bad.id), /invalid or missing evidence/);
  }
  const failed = run('clu-unit', fail);
  for (const action of ['plan', 'build', 'verify']) {
    rejected(report(action, good.id, failed.id), /verified unsuccessful test execution \(FAIL, PARTIAL\)/, 1);
  }
  const blocked = run('clu-unit', { status: 'BLOCKED', exitCode: null, failureCategory: 'install' }, {}, false);
  rejected(report('build', blocked.id), /invalid or missing evidence/);
  assert.equal(existsSync(reports), false);
});

test('build requires the pinned generator while plan stays read-only', async t => {
  const { reports, report, run } = await installation(t);
  const { id } = run();
  assert.equal(success(report('plan', id)).status, 'planned');
  rejected(report('build', id), /Pinned local Allure generator is missing/);
  assert.deepEqual(readdirSync(reports), []);
});

test('generator nonzero exit preserves prior directories and withholds the manifest', async t => {
  const { reports, report, run, stub } = await installation(t);
  mkdirSync(reports, { mode: 0o700 });
  mkdirSync(join(reports, 'old'));
  stub(`console.error('${privateMarker}'); process.exit(23);`);
  rejected(report('build', run().id), /Allure generator failed \(23\)/);
  assert.deepEqual(readdirSync(reports), ['old']);
});

test('generator timeout kills the child and leaves no published or staged report', async t => {
  const { reports, report, run, stub } = await installation(t);
  stub('setInterval(() => {}, 1000);');
  const spawn = childProcess.spawnSync;
  const spy = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(options.timeout, 120_000);
    assert.equal(options.killSignal, 'SIGKILL');
    return spawn(command, args, { ...options, timeout: args.includes('generate') ? 150 : options.timeout });
  });
  syncBuiltinESMExports();
  try {
    rejected(report('build', run().id), /Allure generator timed out/);
    assert.equal(spy.mock.callCount(), 2);
    assert.deepEqual(readdirSync(reports), []);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('rejects partial and unexpected output, count mismatch and wrong case inventory', async t => {
  const { reports, report, run, stub } = await installation(t);
  const { id } = run();
  stub("mkdirSync('report.pending'); writeFileSync('report.pending/index.html', 'partial');");
  rejected(report('build', id), /Allure output inventory/);
  stub("writeFileSync('report.pending/unexpected.txt', 'extra');", true);
  rejected(report('build', id), /Allure output inventory/);
  stub(`const path = 'report.pending/summary.json';
    const summary = JSON.parse(readFileSync(path)); summary.stats.passed++; writeFileSync(path, JSON.stringify(summary));`, true);
  rejected(report('build', id), /aggregate count mismatch/);
  stub(`const path = 'report.pending/test-results.json';
    const index = JSON.parse(readFileSync(path));
    const key = Object.keys(index.byId)[0]; index.byId[key].status = 'broken';
    writeFileSync(path, JSON.stringify(index));`, true);
  rejected(report('build', id), /case inventory mismatch/);
  stub(String.raw`const path = 'report.pending/index.html';
    const html = readFileSync(path, 'utf8').replace(/d\("data\/test-results\/[^"]+","[^"]+"\),/, '');
    writeFileSync(path, html);`, true);
  rejected(report('build', id), /case inventory mismatch/);
  assert.deepEqual(readdirSync(reports), []);
});
