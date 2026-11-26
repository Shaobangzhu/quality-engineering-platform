import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportAllureResults } from '../dist/allure-export.js';
import { allureReportFiles, generateAllureInStage, localizeAllureHtml } from '../dist/allure-generator.js';
import { sha256 } from '../dist/result-contract-v1.js';
import { auditedCluSha, auditedDgiSha } from '../dist/suite-catalog.js';
import { hostingSmoke } from '../scripts/hosting-smoke.js';
import { syntheticHosting } from './fixtures/hosting-http.js';

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
      import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

function historyPath(reports, reportId) {
  return join(reports, reportId, 'history.jsonl');
}

function getHistory(reports, reportId) {
  const bytes = readFileSync(historyPath(reports, reportId), 'utf8');
  assert.equal(bytes.split('\n').length, 2);
  assert.ok(bytes.endsWith('\n'));
  return JSON.parse(bytes);
}

function embeddedReport(reports, reportId) {
  const html = readFileSync(join(reports, reportId, 'index.html'), 'utf8');
  return new Map([...html.matchAll(/d\("([a-zA-Z0-9._/-]+)","([a-zA-Z0-9+/=]+)"\)/g)]
    .map(([, path, payload]) => [path, JSON.parse(Buffer.from(payload, 'base64'))]));
}

async function siteInstallation(t) {
  const installed = await installation(t, true);
  const deployment = mkdtempSync(join(tmpdir(), 'qep-site-'));
  const receipts = join(installed.root, '.local/site-receipts');
  t.after(() => rmSync(deployment, { recursive: true, force: true }));
  const module = pathToFileURL(join(installed.root, 'dist/site-cli.js')).href;
  const { siteCli } = await import(module);
  const site = (action, ...options) => siteCli([action, ...options], deployment);
  const promote = (...ids) => site('promote', ...ids.flatMap(id => ['--run-id', id]), '--publish');
  return { ...installed, deployment, module, receipts, siteCli, site, promote };
}

test('site publishes only the verified index and keeps planning, verification and reuse read-only', async t => {
  const { run, report, site, runCli, promote, deployment, receipts, reports } = await siteInstallation(t);
  const inputs = [run(), run('dgi-backend-unit'), run('dgi-frontend-unit'), run()];
  const ids = inputs.map(input => input.id);
  const { reportId } = success(report('build', ...ids));
  const selections = ids.toReversed().flatMap(id => ['--run-id', id]);
  const source = join(reports, reportId);
  const originalPaths = [
    ...readdirSync(source).map(name => join(source, name)),
    ...inputs.flatMap(run => [run.summaryPath, run.evidence, run.result, run.manifest]),
  ];
  const originals = snapshot(originalPaths);
  const rootBefore = statSync(deployment, { bigint: true }).ctimeNs;
  assert.match(runCli(['help']).stdout, /qe site promote/);
  rejected(runCli(['site', 'promote', ...selections]), /explicit --publish/);
  rejected(site('promote', ...selections), /explicit --publish/);
  rejected(site('plan', ...selections, '--publish'), /explicit --publish/);
  rejected(site('verify', ...selections, '--publish'), /explicit --publish/);
  const plan = success(site('plan', ...selections));
  assert.equal(plan.status, 'planned');
  assert.equal(plan.operation, 'publish');
  assert.equal(plan.reportId, reportId);
  rejected(site('verify', ...selections), /verified current/);
  assert.deepEqual(readdirSync(deployment), []);
  assert.equal(statSync(deployment, { bigint: true }).ctimeNs, rootBefore);
  assert.equal(existsSync(receipts), false);

  assert.equal(success(promote(...ids)).status, 'published');
  assert.deepEqual(readdirSync(deployment).sort(), ['current', 'releases']);
  assert.deepEqual(readdirSync(join(deployment, 'releases')), [reportId]);
  assert.deepEqual(readdirSync(join(deployment, plan.target)), ['index.html']);
  const current = join(deployment, 'current');
  const html = join(deployment, plan.target, 'index.html');
  assert.equal(readlinkSync(current), plan.target);
  assert.equal(statSync(join(deployment, plan.target)).mode & 0o777, 0o755);
  assert.equal(statSync(html).mode & 0o777, 0o444);
  assert.equal(plan.index.bytes, statSync(html).size);
  assert.equal(plan.index.sha256, sha256(readFileSync(html)));
  assert.deepEqual(readFileSync(html), readFileSync(join(source, 'index.html')));
  const [file] = readdirSync(receipts);
  assert.equal(readdirSync(receipts).length, 1);
  const receipt = join(receipts, file);
  assert.equal(statSync(receipts).mode & 0o777, 0o700);
  assert.equal(statSync(receipt).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(receipt)).index, plan.index);

  const paths = [deployment, current, join(deployment, 'releases'), join(deployment, plan.target), html, receipts, receipt];
  const state = () => paths.map(path => {
    const { ino, mtimeNs, ctimeNs } = lstatSync(path, { bigint: true });
    return [ino, mtimeNs, ctimeNs];
  });
  const published = state();
  assert.equal(success(site('plan', ...selections)).operation, 'reuse');
  assert.equal(success(site('verify', ...selections)).status, 'verified');
  const smoke = await hostingSmoke(['--report-id', reportId, ...selections], {
    verify: args => site(...args),
    request: syntheticHosting(readFileSync(html)).request,
  });
  assert.deepEqual(smoke, { status: 'passed', reportId, sha256: plan.index.sha256, bytes: plan.index.bytes });
  assert.equal(success(promote(...ids.toReversed())).status, 'reused');
  assert.deepEqual(state(), published);
  assert.deepEqual(snapshot(originalPaths), originals);
});

test('site rejects invalid provenance, manifests, HTML and source symlinks before deployment', async t => {
  const { run, report, site, promote, deployment, receipts, reports } = await siteInstallation(t);
  const input = run();
  const { reportId } = success(report('build', input.id));
  const directory = join(reports, reportId);
  const html = join(directory, 'index.html');
  const manifest = join(directory, 'report-manifest.json');
  const originalHtml = readFileSync(html);
  const originalManifest = readFileSync(manifest);
  const originalResult = readFileSync(input.result);
  const plan = () => site('plan', '--run-id', input.id);
  writeFileSync(input.result, Buffer.concat([originalResult, Buffer.from(' ')]));
  rejected(plan(), /invalid or missing evidence/);
  writeFileSync(input.result, originalResult);
  writeFileSync(html, Buffer.concat([originalHtml, Buffer.from(' ')]));
  rejected(promote(input.id), /manifest or file digests/);
  writeFileSync(html, originalHtml);
  writeFileSync(manifest, '{');
  rejected(promote(input.id), /Invalid or unavailable/);
  writeFileSync(manifest, originalManifest);

  const text = originalHtml.toString();
  const withPrivateCaseData = text.replace(/d\("(data\/test-results\/[^"]+)","([^"]+)"\)/, (_, name, encoded) => {
    const item = JSON.parse(Buffer.from(encoded, 'base64'));
    item.descriptionHtml = privateMarker;
    return `d("${name}","${Buffer.from(JSON.stringify(item)).toString('base64')}")`;
  });
  for (const changed of [text.replace('</head>', '<script>window.unapproved = true</script></head>'), withPrivateCaseData]) {
    const modified = Buffer.from(changed);
    assert.notDeepEqual(modified, originalHtml);
    writeFileSync(html, modified);
    const refreshed = JSON.parse(originalManifest);
    Object.assign(refreshed.files[0], { bytes: modified.length, sha256: sha256(modified) });
    writeFileSync(manifest, JSON.stringify(refreshed) + '\n');
    assert.equal(success(report('verify', input.id)).status, 'verified');
    rejected(promote(input.id), /public single-file HTML policy/);
  }
  writeFileSync(manifest, originalManifest);

  unlinkSync(html);
  const external = join(reports, 'outside.html');
  writeFileSync(external, originalHtml);
  symlinkSync(external, html);
  rejected(promote(input.id), /Invalid or unavailable/);
  assert.deepEqual(readdirSync(deployment), []);
  assert.equal(existsSync(receipts), false);
});

test('site preserves an accepted release when the staged copy or deployed digest is wrong', async t => {
  const { report, run, site, promote, deployment, receipts } = await siteInstallation(t);
  const first = run(), second = run();
  const prior = success(report('build', first.id));
  const next = success(report('build', second.id));
  success(promote(first.id));
  const current = join(deployment, 'current');
  const originalTarget = readlinkSync(current);
  const write = fs.writeFileSync;
  const spy = t.mock.method(fs, 'writeFileSync', (path, bytes, options) => {
    if (typeof path === 'number' && Buffer.isBuffer(bytes)) {
      const wrong = Buffer.from(bytes);
      wrong[0] ^= 1;
      return write(path, wrong, options);
    }
    return write(path, bytes, options);
  });
  syncBuiltinESMExports();
  try {
    rejected(promote(second.id), /SHA-256 does not match/);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readlinkSync(current), originalTarget);
  assert.deepEqual(readdirSync(deployment).sort(), ['current', 'releases']);
  assert.deepEqual(readdirSync(join(deployment, 'releases')), [prior.reportId]);
  assert.equal(existsSync(join(deployment, 'releases', next.reportId)), false);
  assert.equal(readdirSync(receipts).length, 1);

  const html = join(current, 'index.html');
  const wrong = readFileSync(html);
  wrong[0] ^= 1;
  chmodSync(html, 0o644);
  writeFileSync(html, wrong);
  chmodSync(html, 0o444);
  const before = snapshot([html]);
  rejected(site('verify', '--run-id', first.id), /SHA-256 does not match/);
  rejected(promote(first.id), /SHA-256 does not match/);
  assert.equal(readlinkSync(current), originalTarget);
  assert.deepEqual(snapshot([html]), before);
  assert.equal(readdirSync(receipts).length, 1);
});

async function pausePublisher(t, fixture, id, phase) {
  const marker = join(fixture.root, phase + '-paused');
  const resume = join(fixture.root, phase + '-resume');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [module, deployment, id, phase, marker, resume] = process.argv.slice(1);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if ((phase === 'release' && from.endsWith('/release')) || (phase === 'current' && to.endsWith('/current'))) {
        fs.writeFileSync(marker, '');
        const timer = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(resume)) Atomics.wait(timer, 0, 0, 20);
      }
      rename(from, to);
    };
    syncBuiltinESMExports();
    const { siteCli } = await import(module);
    const result = siteCli(['promote', '--run-id', id, '--publish'], deployment);
    console.log(result.stdout ?? result.stderr);
    process.exitCode = result.exitCode;
  `;
  const child = childProcess.spawn(process.execPath,
    ['--input-type=module', '-e', script, fixture.module, fixture.deployment, id, phase, marker, resume],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  const exited = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  for (let attempt = 0; attempt < 250 && !existsSync(marker); attempt++) {
    assert.equal(child.exitCode, null, output);
    await delay(20);
  }
  assert.ok(existsSync(marker), output);
  return { child, exited, resume: () => writeFileSync(resume, ''), output: () => output };
}

test('site releases the lock on interruption, switches current atomically and rolls back without rewriting releases', async t => {
  const fixture = await siteInstallation(t);
  const { run, report, site, promote, deployment, receipts } = fixture;
  const first = run(), second = run();
  const previous = success(report('build', first.id));
  const upcoming = success(report('build', second.id));
  const oldTarget = success(promote(first.id)).target;
  const newTarget = 'releases/' + upcoming.reportId;
  const current = join(deployment, 'current');
  const oldHtml = join(deployment, oldTarget, 'index.html');
  const newHtml = join(deployment, newTarget, 'index.html');
  const oldBytes = snapshot([oldHtml]);
  const currentBefore = lstatSync(current, { bigint: true });

  const interrupted = await pausePublisher(t, fixture, second.id, 'release');
  const stages = () => readdirSync(deployment).filter(name => name.startsWith('.pending-'));
  const [abandoned] = stages();
  assert.ok(abandoned);
  assert.equal(statSync(join(deployment, abandoned)).mode & 0o777, 0o700);
  assert.equal(existsSync(newHtml), false);
  rejected(promote(second.id), /Another site publisher is active/);
  assert.equal(success(site('verify', '--run-id', first.id)).reportId, previous.reportId);
  assert.ok(interrupted.child.kill('SIGKILL'));
  assert.deepEqual(await interrupted.exited, [null, 'SIGKILL']);
  assert.equal(readlinkSync(current), oldTarget);
  assert.equal(lstatSync(current, { bigint: true }).ino, currentBefore.ino);
  assert.deepEqual(stages(), [abandoned]);

  const retry = await pausePublisher(t, fixture, second.id, 'current');
  assert.equal(readlinkSync(current), oldTarget);
  assert.deepEqual(readFileSync(join(current, 'index.html')), oldBytes[0][0]);
  assert.deepEqual(readdirSync(join(deployment, newTarget)), ['index.html']);
  assert.equal(success(site('plan', '--run-id', second.id)).operation, 'activate');
  rejected(promote(first.id), /Another site publisher is active/);
  retry.resume();
  assert.deepEqual(await retry.exited, [0, null], retry.output());
  assert.equal(JSON.parse(retry.output()).status, 'published');
  assert.equal(readlinkSync(current), newTarget);
  assert.deepEqual(readFileSync(join(current, 'index.html')), readFileSync(newHtml));
  assert.deepEqual(stages(), [abandoned]);
  assert.equal(success(site('verify', '--run-id', second.id)).reportId, upcoming.reportId);
  rejected(site('verify', '--run-id', first.id), /verified current/);

  const both = snapshot([oldHtml, newHtml]);
  assert.deepEqual([both[0]], oldBytes);
  assert.equal(success(promote(first.id)).status, 'activated');
  assert.equal(readlinkSync(current), oldTarget);
  assert.equal(success(site('verify', '--run-id', first.id)).reportId, previous.reportId);
  assert.deepEqual(snapshot([oldHtml, newHtml]), both);
  assert.equal(readdirSync(receipts).length, 4);
});

test('site rejects missing roots, unsafe parents, traversal and symlink escapes', async t => {
  const { root, run, report, site, siteCli, promote, deployment, receipts } = await siteInstallation(t);
  const { id } = run();
  const { reportId } = success(report('build', id));
  const args = ['promote', '--run-id', id, '--publish'];
  rejected(site('promote', '--run-id', '../' + id, '--publish'), /Malformed Run ID/);
  rejected(site('promote', '--html', '/tmp/report.html', '--publish'), /explicit --run-id/);
  rejected(siteCli(args, deployment + '/../' + deployment.split('/').at(-1)), /overlapping deployment root/);
  rejected(siteCli(args, join(root, '.local')), /overlapping deployment root/);
  const absent = join(deployment, 'missing/site');
  rejected(siteCli(args, absent), /must already exist/);
  chmodSync(deployment, 0o777);
  rejected(promote(id), /owner-controlled/);
  mkdirSync(join(deployment, 'site'), { mode: 0o700 });
  rejected(siteCli(args, join(deployment, 'site')), /Unsafe deployment parent/);
  chmodSync(deployment, 0o700);
  rmSync(join(deployment, 'site'), { recursive: true });
  const alias = join(deployment, 'alias');
  symlinkSync(deployment, alias);
  rejected(siteCli(args, join(alias, 'somewhere')), /real directory parents/);
  rejected(siteCli(args, alias), /real directory parents/);
  unlinkSync(alias);

  const releases = join(deployment, 'releases');
  symlinkSync(root, releases);
  rejected(promote(id), /Unsafe site directory/);
  unlinkSync(releases);
  mkdirSync(releases, { mode: 0o755 });
  const release = join(releases, reportId);
  symlinkSync(root, release);
  rejected(promote(id), /Invalid or unavailable/);
  unlinkSync(release);
  const current = join(deployment, 'current');
  for (const target of [root, '../' + reportId, 'releases/../' + reportId, 'releases/' + 'f'.repeat(64)]) {
    symlinkSync(target, current);
    rejected(promote(id), /Unsafe site current target|current release is missing/);
    assert.equal(readlinkSync(current), target);
    unlinkSync(current);
  }
  assert.deepEqual(readdirSync(releases), []);
  assert.equal(existsSync(join(deployment, 'missing')), false);
  assert.equal(existsSync(receipts), false);
});

test('site detects deployment root replacement before publishing the staged release', async t => {
  const { root, run, report, promote, deployment, receipts } = await siteInstallation(t);
  const { id } = run();
  success(report('build', id));
  const displaced = deployment + '-displaced';
  const outside = join(root, 'outside');
  mkdirSync(outside);
  let replaced = false;
  const fsync = fs.fsyncSync;
  const spy = t.mock.method(fs, 'fsyncSync', fd => {
    fsync(fd);
    if (readlinkSync('/proc/self/fd/' + fd).startsWith(deployment + '/.pending-')) {
      fs.renameSync(deployment, displaced);
      symlinkSync(outside, deployment);
      replaced = true;
    }
  });
  syncBuiltinESMExports();
  try {
    rejected(promote(id), /Deployment directory identity changed/);
    assert.equal(replaced, true);
    assert.deepEqual(readdirSync(outside), []);
    assert.deepEqual(readdirSync(join(displaced, 'releases')), []);
    assert.equal(existsSync(join(displaced, 'current')), false);
    assert.equal(existsSync(receipts), false);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    if (replaced) {
      unlinkSync(deployment);
      fs.renameSync(displaced, deployment);
    }
  }
});

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
  const built = success(report('build', input.id));
  assert.equal(built.status, 'built');
  assert.deepEqual(built.history, { acceptedLaunches: 1, previousReportId: null });
  const output = join(root, plan.directory);
  const manifestPath = join(output, 'report-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.history, built.history);
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
  assert.equal(statSync(historyPath(reports, plan.reportId)).mode & 0o777, 0o600);
  const entry = getHistory(reports, plan.reportId);
  assert.equal(Object.keys(entry.testResults).length, 2);
  assert.ok(entry.timestamp > 0);
  const embedded = embeddedReport(reports, plan.reportId);
  assert.ok(![...embedded.keys()].some(path => path.startsWith('data/history/')));
  assert.deepEqual(Object.values(embedded.get('widgets/charts.json').general).map(chart => chart.type), ['currentStatus']);
  const cli = childProcess.spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'report', 'verify', '--run-id', input.id], {
    cwd: tmpdir(), encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  const verified = JSON.parse(cli.stdout);
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.history, built.history);
  const reused = success(report('build', input.id));
  assert.equal(reused.status, 'reused');
  assert.deepEqual(reused.history, built.history);
  assert.deepEqual(snapshot([...files, manifestPath]), published);
  assert.deepEqual(snapshot(paths), before);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, policy: 'different-policy' }));
  const corrupted = snapshot([manifestPath]);
  rejected(report('verify', input.id), /manifest or file digests/);
  rejected(report('build', input.id), /manifest or file digests/);
  assert.deepEqual(snapshot([manifestPath]), corrupted);
});

test('three-suite report checks all case counts across audited source identities', async t => {
  const { reports, report, run } = await installation(t, true);
  const launch = () => [run('dgi-backend-unit').id, run('dgi-frontend-unit').id, run().id];
  const ids = launch();
  const historical = run('clu-unit', fail);
  const before = snapshot([historical.summaryPath, historical.result, historical.manifest]);
  const built = success(report('build', ...ids));
  assert.deepEqual(built.counts, { total: 4, passed: 3, skipped: 1, failed: 0, broken: 0, unknown: 0 });
  assert.deepEqual(built.runs.map(run => run.runId), [...ids].sort());
  const first = getHistory(reports, built.reportId);
  const firstFiles = [historyPath(reports, built.reportId), join(reports, built.reportId, 'report-manifest.json')];
  const accepted = snapshot(firstFiles);
  assert.deepEqual(built.history, { acceptedLaunches: 1, previousReportId: null });
  assert.equal(Object.keys(first.testResults).length, 4);
  assert.equal(success(report('verify', ...ids.toReversed())).reportId, built.reportId);
  assert.equal(success(report('build', ...ids.toReversed())).status, 'reused');
  assert.deepEqual(readdirSync(reports), [built.reportId]);

  const next = launch();
  const second = success(report('build', ...next));
  assert.notEqual(second.reportId, built.reportId);
  assert.deepEqual(second.history, { acceptedLaunches: 2, previousReportId: built.reportId });
  const entry = getHistory(reports, second.reportId);
  assert.notEqual(entry.uuid, first.uuid);
  assert.deepEqual(Object.keys(entry.testResults).sort(), Object.keys(first.testResults).sort());
  assert.deepEqual([...entry.knownTestCaseIds].sort(), [...first.knownTestCaseIds].sort());
  const embedded = embeddedReport(reports, second.reportId);
  assert.deepEqual(embedded.get(`data/history/${first.uuid}.json`), first);
  assert.ok(Object.values(embedded.get('widgets/charts.json').general).some(chart => chart.type === 'coverageDiff'));
  for (const [key, item] of Object.entries(entry.testResults)) {
    const current = embedded.get(`data/test-results/${item.id}.json`);
    assert.notEqual(item.id, first.testResults[key].id);
    assert.deepEqual(current.history, [first.testResults[key]]);
    for (const field of ['start', 'stop', 'duration']) {
      assert.ok(!Object.hasOwn(item, field));
      assert.ok(!Object.hasOwn(current, field));
    }
  }
  assert.equal(success(report('verify', ...next.toReversed())).history.acceptedLaunches, 2);
  assert.equal(success(report('verify', ...ids)).history.acceptedLaunches, 1);
  assert.deepEqual(snapshot(firstFiles), accepted);
  assert.deepEqual(snapshot([historical.summaryPath, historical.result, historical.manifest]), before);
});

test('two explicitly selected runs of one suite retain both executions of the same cases', async t => {
  const { reports, report, run } = await installation(t, true);
  const single = success(report('build', run().id));
  const ids = [run().id, run().id];
  const combined = success(report('build', ...ids));
  assert.equal(combined.counts.total, 4);
  assert.equal(success(report('verify', ...ids)).counts.passed, 2);
  const initial = getHistory(reports, single.reportId);
  const current = getHistory(reports, combined.reportId);
  assert.equal(current.knownTestCaseIds.length, 2);
  assert.equal(Object.keys(current.testResults).length, 4);
  assert.ok(Object.keys(initial.testResults).every(key => Object.hasOwn(current.testResults, key)));
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
    if (command !== process.execPath) return spawn(command, args, options);
    assert.equal(options.timeout, 120_000);
    assert.equal(options.killSignal, 'SIGKILL');
    return spawn(command, args, { ...options, timeout: args.includes('generate') ? 150 : options.timeout });
  });
  syncBuiltinESMExports();
  try {
    rejected(report('build', run().id), /Allure generator timed out/);
    assert.equal(spy.mock.calls.filter(call => call.arguments[0] === process.execPath).length, 2);
    assert.deepEqual(readdirSync(reports), []);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('excludes another writer while verify stays read-only and retries after a killed build', async t => {
  const { root, reports, report, run, stub } = await installation(t);
  stub('', true);
  const first = run();
  const pending = run();
  const next = run();
  const built = success(report('build', first.id));
  const acceptedPath = historyPath(reports, built.reportId);
  const accepted = snapshot([acceptedPath]);
  stub(`writeFileSync('history.jsonl', '{partial');
    writeFileSync('generator.pid', String(process.pid));
    setTimeout(() => process.exit(24), 10_000);`);
  const writer = childProcess.spawn(process.execPath, [join(root, 'dist/cli.js'), 'report', 'build', '--run-id', pending.id], {
    cwd: tmpdir(), stdio: 'ignore',
  });
  const exited = once(writer, 'exit');
  let stage;
  let generatorPid;
  try {
    for (let attempt = 0; attempt < 250; attempt++) {
      assert.equal(writer.exitCode, null);
      stage = readdirSync(reports).find(name => name.startsWith('pending-'));
      const marker = stage && join(reports, stage, 'generator.pid');
      if (marker && existsSync(marker)) {
        generatorPid = Number(readFileSync(marker, 'utf8'));
        if (generatorPid) break;
      }
      await delay(20);
    }
    assert.ok(generatorPid, 'generator reached staged write');
    rejected(report('build', next.id), /Another report history writer is active/);
    assert.equal(success(report('verify', first.id)).status, 'verified');
    assert.deepEqual(snapshot([acceptedPath]), accepted);
    assert.ok(writer.kill('SIGKILL'));
    assert.deepEqual(await exited, [null, 'SIGKILL']);
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    await exited;
    if (generatorPid) {
      try {
        process.kill(generatorPid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  assert.ok(existsSync(join(reports, stage, 'history.jsonl')));
  assert.deepEqual(snapshot([acceptedPath]), accepted);
  stub('', true);
  const retried = success(report('build', pending.id));
  assert.deepEqual(retried.history, { acceptedLaunches: 2, previousReportId: built.reportId });
  assert.equal(success(report('verify', pending.id)).status, 'verified');
  assert.deepEqual(snapshot([acceptedPath]), accepted);
});

test('rejects a corrupted or missing accepted history entry without restarting the journal', async t => {
  const { reports, report, run } = await installation(t, true);
  const first = run();
  const second = run();
  const third = run();
  const original = success(report('build', first.id));
  const originalPath = historyPath(reports, original.reportId);
  const accepted = snapshot([originalPath]);
  const built = success(report('build', second.id));
  const target = historyPath(reports, built.reportId);
  writeFileSync(target, '{partial\n');
  const corrupted = snapshot([target]);
  rejected(report('verify', second.id), /Accepted report history .* invalid/);
  rejected(report('build', third.id), /Accepted report history .* invalid/);
  assert.equal(success(report('verify', first.id)).status, 'verified');
  assert.deepEqual(snapshot([target]), corrupted);
  unlinkSync(target);
  rejected(report('verify', second.id), /published report inventory/);
  rejected(report('build', third.id), /Accepted report history is missing/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(snapshot([originalPath]), accepted);
  assert.deepEqual(readdirSync(reports).sort(), [built.reportId, original.reportId].sort());
});

test('withholds history when a generator alters the staged prefix, record, or report', async t => {
  const { reports, report, run, stub } = await installation(t);
  stub('', true);
  const first = run();
  const second = run();
  const built = success(report('build', first.id));
  const target = historyPath(reports, built.reportId);
  const accepted = snapshot([target]);
  for (const [fault, diagnostic] of [
    ["unlinkSync('history.jsonl');", /Missing or invalid staged Allure history/],
    [String.raw`const path = 'history.jsonl';
       const lines = readFileSync(path, 'utf8').split('\n');
       lines[0] += ' '; writeFileSync(path, lines.join('\n'));`, /Missing or invalid staged Allure history/],
    [String.raw`const path = 'history.jsonl';
       const lines = readFileSync(path, 'utf8').split('\n');
       const point = JSON.parse(lines[1]);
       const item = Object.values(point.testResults)[0];
       item.status = item.status === 'passed' ? 'skipped' : 'passed';
       lines[1] = JSON.stringify(point); writeFileSync(path, lines.join('\n'));`, /case inventory mismatch/],
    [String.raw`const path = 'report.pending/index.html';
       const html = readFileSync(path, 'utf8').replace(/d\("data\/history\/[^"]+","[^"]+"\),/, '');
       writeFileSync(path, html);`, /Unexpected Allure embedded history data/],
    ["writeFileSync('report.pending/unexpected.txt', 'extra');", /Allure output inventory/],
  ]) {
    stub(fault, true);
    rejected(report('build', second.id), diagnostic);
    assert.deepEqual(readdirSync(reports), [built.reportId]);
    assert.deepEqual(snapshot([target]), accepted);
    assert.equal(success(report('verify', first.id)).status, 'verified');
  }
  stub('', true);
  const retried = success(report('build', second.id));
  assert.deepEqual(retried.history, { acceptedLaunches: 2, previousReportId: built.reportId });
  assert.deepEqual(snapshot([target]), accepted);
});

test('keeps pre-history report manifests reusable without backfilling a launch', async t => {
  const { root, reports, report, run, site } = await siteInstallation(t);
  const original = run();
  const { status, acceptance, directory, ...plan } = success(report('plan', original.id));
  assert.equal(status, 'planned');
  assert.equal(acceptance, 'verified-successful-launch');
  const stage = mkdtempSync(join(root, 'legacy-'));
  const inputs = join(stage, 'allure-results');
  mkdirSync(inputs);
  for (const { name, bytes } of exportAllureResults(JSON.parse(readFileSync(original.result)), 'execution')) {
    writeFileSync(join(inputs, name), bytes);
  }
  assert.equal(generateAllureInStage(stage), 0);
  const target = join(root, directory);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const files = allureReportFiles.map(name => {
    const raw = readFileSync(join(stage, 'report.pending', name));
    const bytes = name === 'index.html' ? Buffer.from(localizeAllureHtml(raw.toString())) : raw;
    writeFileSync(join(target, name), bytes);
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = join(target, 'report-manifest.json');
  writeFileSync(manifest, JSON.stringify({ ...plan, schemaVersion: 1, files }) + '\n');
  const old = snapshot([...allureReportFiles.map(name => join(target, name)), manifest]);
  assert.equal(success(report('verify', original.id)).schemaVersion, 1);
  rejected(site('plan', '--run-id', original.id), /accepted report history entry/);
  assert.equal(success(report('build', original.id)).status, 'reused');
  assert.equal(existsSync(historyPath(reports, plan.reportId)), false);
  assert.deepEqual(success(report('build', run().id)).history, { acceptedLaunches: 1, previousReportId: null });
  assert.deepEqual(snapshot([...allureReportFiles.map(name => join(target, name)), manifest]), old);
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
