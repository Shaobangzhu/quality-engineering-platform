import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { files as archiveFiles, integrity, manifest as archiveManifest, tar } from './fixtures/clu-archive.js';
import { assertRejected, dgi, fixture, snapshot } from './git-fixture.js';

const realNpm = realpathSync(join(dirname(process.execPath), 'npm'));
const npmVersion = JSON.parse(readFileSync(join(dirname(realNpm), '../package.json'))).version;
const origin = 'https://github.com/Shaobangzhu/delivery-geo-intelligence.git';
const producerSha = 'e'.repeat(40);
const manifest = { ...archiveManifest, engines: { node: '>=22.23.4', npm: '>=10.9.0' } };
const files = { ...archiveFiles, 'package.json': JSON.stringify(manifest) };
const clu = manifest.name;
const entry = 'node_modules/' + clu;
const publishedDist = files['dist/index.js'].replace("'button'", "'select'");
const archive = (members) => tar(Object.entries(members).map(([path, body]) => ({ path: 'package/' + path, body })));
const candidate = archive(files);
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readLock = (path) => readJson(join(path, 'package-lock.json'));

function setup(t, options = {}) {
  const root = { ...dgi, private: true, workspaces: ['frontend', 'backend'] };
  const f = fixture(t, root, 'candidate');
  const frontend = { name: 'frontend', version: '1.0.0', private: true, type: 'module', scripts: { test: 'exit 93' },
    dependencies: { [clu]: options.publishedSpec ?? manifest.version, react: '^19.0.0', 'react-dom': '^19.0.0' } };
  const backend = { name: 'backend', version: '1.0.0', private: true, scripts: { 'test:unit': 'exit 94' } };
  for (const pkg of [frontend, backend]) {
    mkdirSync(join(f.source, pkg.name));
    writeJson(join(f.source, pkg.name, 'package.json'), pkg);
  }
  const lock = { name: root.name, lockfileVersion: 3, requires: true, packages: {
    '': { name: root.name, workspaces: root.workspaces },
    frontend: { version: frontend.version, dependencies: frontend.dependencies },
    backend: { version: backend.version },
    'node_modules/frontend': { resolved: 'frontend', link: true },
    'node_modules/backend': { resolved: 'backend', link: true },
  } };

  const registry = new Map([
    [manifest, archive({ ...files, 'dist/index.js': publishedDist })],
    [{ name: 'react', version: options.reactVersion ?? '19.0.0', main: './index.js' }],
    [{ name: 'react-dom', version: '19.0.0', main: './index.js', peerDependencies: { react: '^19.0.0' },
      scripts: { postinstall: 'node -e "process.exit(95)"' } }],
  ]);
  const cached = [];
  for (const [pkg, bytes = archive({ 'package.json': JSON.stringify(pkg), 'index.js': 'module.exports = {};' })] of registry) {
    const filename = pkg.name.split('/').at(-1) + '-' + pkg.version + '.tgz';
    lock.packages['node_modules/' + pkg.name] = {
      version: pkg.version, resolved: 'https://registry.npmjs.org/' + pkg.name + '/-/' + filename,
      integrity: integrity(bytes), ...(pkg === manifest ? { license: pkg.license } : {}),
      ...(pkg.engines ? { engines: pkg.engines } : {}),
      ...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
      ...(pkg.name === 'react-dom' ? { hasInstallScript: true } : {}),
    };
    const path = join(f.temp, filename);
    writeFileSync(path, bytes);
    cached.push(path);
  }
  options.changeLock?.(lock);
  writeJson(join(f.source, 'package-lock.json'), lock);
  options.changeTree?.(f);
  f.git('add', '-A');
  f.git('-c', 'user.name=QE Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'DGI npm workspaces');
  f.git('remote', 'add', 'origin', origin);
  const sha = f.git('rev-parse', 'HEAD');

  const gate = join(f.cwd, '.local', 'consumer-gate');
  const retained = join(gate, producerSha);
  mkdirSync(retained, { recursive: true, mode: 0o700 });
  const stage = (bytes, version = manifest.version) => {
    const archivePath = join(retained, 'candidate.tgz');
    if (existsSync(archivePath)) chmodSync(archivePath, 0o600);
    writeFileSync(archivePath, bytes, { mode: 0o400 });
    writeJson(join(retained, 'receipt.json'), { schemaVersion: 1, producerSha, name: clu, version,
      npmVersion, archive: 'candidate.tgz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: integrity(bytes), buildCommand: manifest.scripts.build, unitCommand: manifest.scripts.test });
  };
  stage(candidate);

  const log = join(f.temp, 'npm.jsonl');
  // Exercise the installed npm offline with synthetic registry tarballs in the
  // run's own cache. Optional mutations simulate bad state after real npm ci.
  writeFileSync(join(f.temp, 'npm/bin/npm-cli.js'), `
    const assert = require('node:assert/strict');
    const {appendFileSync, cpSync, existsSync, readFileSync, writeFileSync} = require('node:fs');
    const {spawnSync} = require('node:child_process');
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
    assert.deepEqual(args, ['ci', '--ignore-scripts', '--include=dev']);
    assert.equal(readFileSync('.git/HEAD', 'utf8').trim(), ${JSON.stringify(sha)});
    assert.equal(process.env.QEP_SYNTHETIC_CREDENTIAL, undefined);
    assert.equal(process.env.npm_config_ignore_scripts, 'true');
    assert(!existsSync('.env'));
    assert(!existsSync('frontend/package-lock.json'));
    function run(args) {
      const result = spawnSync(process.execPath, [${JSON.stringify(realNpm)}, ...args, '--offline'], {stdio: 'inherit'});
      if (result.status !== 0) process.exit(result.status ?? 96);
    }
    for (const path of ${JSON.stringify(cached)}) run(['cache', 'add', path]);
    run(args);
    ${options.afterNpm ?? ''}
  `);
  writeJson(join(f.temp, 'npm/package.json'), { name: 'npm', version: npmVersion });
  f.env.QEP_SYNTHETIC_CREDENTIAL = 'excluded fixture variable';
  const args = ({ source = f.source, dgiSha = sha, approved = integrity(candidate), install = false } = {}) =>
    ['inject', '--source', source, '--sha', dgiSha, '--candidate-sha', producerSha, '--integrity', approved,
      ...(install ? ['--install-deps'] : [])];
  return { ...f, sha, gate, lock, retained, stage, args, inject: (options) => f.invoke(args(options)),
    steps: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('prepares fresh detached baseline and candidate checkouts without npm authorization', (t) => {
  const f = setup(t);
  const before = snapshot(f.source);
  const first = success(f.inject({ dgiSha: f.sha.toUpperCase() }));
  const second = success(f.inject());
  assert.notEqual(first.runId, second.runId);
  assert.equal(first.status, 'prepared');
  assert.equal(first.installed, null);
  assert.deepEqual(f.steps(), []);
  const base = first.baseline.workspace;
  const work = first.candidate.workspace;
  assert.notEqual(base, work);
  for (const path of [base, work]) {
    assert.equal(readFileSync(join(path, '.git/HEAD'), 'utf8').trim(), f.sha);
    assert.equal(existsSync(join(path, 'node_modules')), false);
    assert.equal(existsSync(join(path, '.env')), false);
    assert.equal(existsSync(join(path, 'frontend/package-lock.json')), false);
  }
  assert.deepEqual(readLock(base), f.lock);
  assert.deepEqual(first.baseline.published, {
    version: manifest.version, resolved: f.lock.packages[entry].resolved, integrity: f.lock.packages[entry].integrity,
  });
  assert.notEqual(first.baseline.published.integrity, first.candidate.integrity);
  const expected = structuredClone(f.lock);
  expected.packages.frontend.dependencies[clu] = 'file:../qep-clu-candidate.tgz';
  expected.packages[entry] = { version: manifest.version, resolved: 'file:qep-clu-candidate.tgz',
    integrity: integrity(candidate), license: 'MIT', engines: manifest.engines, peerDependencies: manifest.peerDependencies };
  assert.deepEqual(readLock(work), expected);
  const frontend = readJson(join(base, 'frontend/package.json'));
  frontend.dependencies[clu] = expected.packages.frontend.dependencies[clu];
  assert.deepEqual(readJson(join(work, 'frontend/package.json')), frontend);
  assert.equal(first.candidate.archivePath, join(work, 'qep-clu-candidate.tgz'));
  assert.deepEqual(readFileSync(first.candidate.archivePath), candidate);
  assert.deepEqual(snapshot(f.source), before);
});

test('authorized real npm ci installs the approved same-version tarball and resolves dist and one React', (t) => {
  const f = setup(t);
  const before = snapshot(f.source);
  const result = success(f.inject({ install: true }));
  assert.equal(result.status, 'installed-and-verified');
  const { workspace } = result.candidate;
  assert.deepEqual(f.steps(), [{ args: ['ci', '--ignore-scripts', '--include=dev'], cwd: workspace }]);
  assert.equal(existsSync(join(result.baseline.workspace, 'node_modules')), false);
  assert.equal(result.installed.react, join(workspace, 'node_modules/react/index.js'));
  assert.equal(result.installed.reactVersion, '19.0.0');
  const installed = readJson(join(workspace, 'node_modules/.package-lock.json')).packages[entry];
  assert.equal(installed.integrity, integrity(candidate));
  assert.equal(installed.resolved, 'file:qep-clu-candidate.tgz');
  assert.deepEqual(readJson(join(workspace, entry, 'package.json')), manifest);
  for (const [key, file] of [['javascript', 'dist/index.js'], ['declaration', 'dist/index.d.ts'], ['stylesheet', 'dist/styles.css']]) {
    assert.equal(result.installed[key], join(workspace, entry, file));
    assert.equal(readFileSync(result.installed[key], 'utf8'), files[file]);
  }
  assert.deepEqual(snapshot(f.source), before);
});

test('changes the candidate version without changing the published baseline range or resolution', (t) => {
  const publishedSpec = '^' + manifest.version;
  const f = setup(t, { publishedSpec });
  const version = '0.2.0';
  const bytes = archive({ ...files, 'package.json': JSON.stringify({ ...manifest, version }) });
  f.stage(bytes, version);
  const result = success(f.inject({ install: true, approved: integrity(bytes) }));
  assert.equal(result.candidate.version, version);
  assert.equal(readJson(join(result.candidate.workspace, entry, 'package.json')).version, version);
  const baseline = readLock(result.baseline.workspace);
  assert.equal(baseline.packages.frontend.dependencies[clu], publishedSpec);
  assert.deepEqual(baseline.packages[entry], f.lock.packages[entry]);
});

test('requires both SHAs and separately pinned archive integrity before using npm', (t) => {
  const f = setup(t);
  const args = f.args({ install: true });
  for (const flag of ['--sha', '--candidate-sha', '--integrity']) {
    const incomplete = [...args];
    incomplete.splice(incomplete.indexOf(flag), 2);
    assertRejected(f.invoke(incomplete), /Supply candidate inject/);
  }
  assertRejected(f.inject({ dgiSha: f.sha.slice(0, 12), install: true }), /Supply candidate inject/);
  assertRejected(f.inject({ dgiSha: '0'.repeat(40), install: true }), /HEAD does not match/);
  assertRejected(f.inject({ approved: integrity(Buffer.from('unapproved')), install: true }), /SHA-512 does not match/);
  const alternate = archive({ ...files, 'dist/index.js': publishedDist });
  f.stage(alternate);
  assertRejected(f.inject({ install: true }), /SHA-512 does not match/);
  const path = join(f.retained, 'candidate.tgz');
  chmodSync(path, 0o600);
  writeFileSync(path, candidate);
  assertRejected(f.inject({ approved: integrity(alternate), install: true }), /receipt or archive digest mismatch/);
  assert.deepEqual(f.steps(), []);
  assert.deepEqual(readdirSync(f.gate), [producerSha]);
});

for (const [name, afterNpm, error] of [
  ['wrong installed integrity', `
    const lock = JSON.parse(readFileSync('node_modules/.package-lock.json'));
    lock.packages[${JSON.stringify(entry)}].integrity = ${JSON.stringify(integrity(Buffer.from('wrong')))};
    writeFileSync('node_modules/.package-lock.json', JSON.stringify(lock));
  `, /Installed npm lockfile must record/],
  ['unexpected lockfile dependency upgrade', `
    const lock = JSON.parse(readFileSync('package-lock.json'));
    lock.packages['node_modules/react'].version = '19.9.0';
    writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\\n');
  `, /Unexpected candidate dependency delta in package-lock.json/],
  ['published package substituted despite matching version', `
    writeFileSync(${JSON.stringify(entry + '/dist/index.js')}, ${JSON.stringify(publishedDist)});
  `, /Installed CLU package does not match/],
  ['duplicate installed React', `
    cpSync('node_modules/react', ${JSON.stringify(entry + '/node_modules/react')}, {recursive: true});
  `, /integrity/],
  ['installed export changed', `
    const path = ${JSON.stringify(entry + '/package.json')};
    const pkg = JSON.parse(readFileSync(path));
    pkg.exports['./styles.css'] = './src/styles.css';
    writeFileSync(path, JSON.stringify(pkg));
  `, /Installed CLU package does not match/],
]) {
  test('rejects ' + name, (t) => {
    const f = setup(t, { afterNpm });
    const before = snapshot(f.source);
    assertRejected(f.inject({ install: true }), error);
    assert.equal(f.steps().length, 1);
    assert.deepEqual(readdirSync(f.gate), [producerSha]);
    assert.deepEqual(snapshot(f.source), before);
  });
}

test('rejects duplicate locked React, an incompatible React peer, and a frontend lockfile before npm', (t) => {
  const duplicate = setup(t, { changeLock(lock) {
    lock.packages['frontend/node_modules/react'] = lock.packages['node_modules/react'];
  } });
  const incompatible = setup(t, { reactVersion: '18.0.0' });
  const nested = setup(t, { changeTree(f) { writeJson(join(f.source, 'frontend/package-lock.json'), {}); } });
  assertRejected(duplicate.inject({ install: true }), /one hoisted React installation/);
  assertRejected(incompatible.inject({ install: true }), /compatible with the frontend and CLU React peer/);
  assertRejected(nested.inject({ install: true }), /single v3 root lockfile/);
  for (const f of [duplicate, incompatible, nested]) assert.deepEqual(f.steps(), []);
});

test('rejects an approved digest with invalid package exports before npm', (t) => {
  const f = setup(t);
  const invalid = archive({ ...files, 'package.json': JSON.stringify({ ...manifest, exports: { '.': './src/index.ts' } }) });
  f.stage(invalid);
  assertRejected(f.inject({ approved: integrity(invalid), install: true }), /Invalid CLU ESM, declaration or CSS export contract/);
  assert.deepEqual(f.steps(), []);
});

test('requires the approved origin and pristine source and rejects source path escapes', (t) => {
  const f = setup(t);
  const alias = join(f.temp, 'alias');
  symlinkSync(f.source, alias);
  assertRejected(f.inject({ source: alias, install: true }), /without symlinks/);
  assertRejected(f.inject({ source: f.source + '/../' + f.source.split('/').at(-1), install: true }), /without traversal/);
  f.git('remote', 'set-url', 'origin', 'https://github.com/example/delivery-geo-intelligence.git');
  assertRejected(f.inject({ install: true }), /approved DGI repository/);
  f.git('remote', 'set-url', 'origin', origin);
  writeFileSync(join(f.source, 'untracked'), 'dirty');
  assertRejected(f.inject({ install: true }), /working tree is dirty/);
  assert.deepEqual(f.steps(), []);
  const escape = setup(t, { changeTree(f) { symlinkSync('../outside', join(f.source, 'escape')); } });
  assertRejected(escape.inject({ install: true }), /symlink escapes/);
  assert.deepEqual(escape.steps(), []);
});
