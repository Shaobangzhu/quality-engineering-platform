import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { verifyCandidateArchive } from '../dist/clu-candidate-archive.js';
import { assertRejected, fixture, snapshot } from './git-fixture.js';

const realNpm = realpathSync(join(dirname(process.execPath), 'npm'));
const origin = 'https://github.com/Shaobangzhu/react-clu-component-lib.git';
const manifest = {
  name: '@shaobangzhu/clu-ui', version: '0.1.0-fixture.1', private: false, type: 'module', license: 'MIT',
  main: './dist/index.js', module: './dist/index.js', types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './styles.css': './dist/styles.css' },
  sideEffects: ['./dist/styles.css'], files: ['dist/**/*.d.ts', 'dist/index.js', 'dist/styles.css'],
  scripts: { build: 'vite build && node scripts/build-types.mjs', test: 'vitest run', prepack: 'npm run build' },
  peerDependencies: { react: '^19.0.0' }, devDependencies: { vite: '1.0.0', vitest: '1.0.0', react: '19.0.0' },
};
const esm = "import { createElement } from 'react';\nconst Button = () => createElement('button');\nexport { Button };\n";
const files = {
  'package.json': JSON.stringify(manifest),
  'README.md': '# Synthetic CLU',
  LICENSE: 'MIT fixture license',
  'dist/index.js': esm,
  'dist/index.d.ts': "export { Button } from './button.js';\n",
  'dist/button.d.ts': 'export declare const Button: () => unknown;\n',
  'dist/styles.css': '.clu-dialog,.clu-table{--clu-color:#fff}',
};

function tar(members) {
  const blocks = [];
  for (const { path, body = '', type = '0', link = '', mode = 0o644 } of members) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(path);
    header.write(mode.toString(8).padStart(7, '0'), 100);
    header.write(data.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157);
    header.write('ustar\x0000', 257);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

function setup(t, { changeManifest = () => {}, build = {}, unit = 'pass', packIntegrity = false } = {}) {
  const pkg = structuredClone(manifest);
  changeManifest(pkg);
  const f = fixture(t, pkg, 'candidate');
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    '': { name: pkg.name, version: pkg.version, devDependencies: pkg.devDependencies, peerDependencies: pkg.peerDependencies },
  } };
  const deps = [];
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    const dep = { name, version, scripts: { postinstall: 'node -e "process.exit(90)"' } };
    if (name !== 'react') dep.bin = { [name]: 'cli.cjs' };
    const contents = [{ path: 'package/package.json', body: JSON.stringify(dep) }];
    if (dep.bin) {
      contents.push({
        path: 'package/cli.cjs', mode: 0o755,
        body: '#!/usr/bin/env node\n' + (name === 'vite'
          ? 'require("node:fs").mkdirSync("dist");'
          : unit === 'pass' ? 'console.log("Tests  1 passed (1)");'
            : unit === 'missing' ? 'console.log("no tests executed");' : 'process.exitCode = 1;'),
      });
    }
    const archive = tar(contents);
    const depPath = join(f.temp, name + '.tgz');
    writeFileSync(depPath, archive);
    deps.push(depPath);
    lock.packages['node_modules/' + name] = { version, dev: true, hasInstallScript: true, bin: dep.bin,
      resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz', integrity: integrity(archive) };
  }
  writeFileSync(join(f.source, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(join(f.source, '.gitignore'), '.env\nnode_modules/\ndist/\n');
  for (const path of ['README.md', 'LICENSE']) writeFileSync(join(f.source, path), files[path]);
  mkdirSync(join(f.source, 'scripts'));
  const output = Object.fromEntries(Object.entries({ ...files, ...build }).filter(([path, data]) =>
    path.startsWith('dist/') && data !== null));
  writeFileSync(join(f.source, 'scripts/build-types.mjs'), 'import {writeFileSync} from "node:fs";\n' +
    'for (const [path, text] of Object.entries(' + JSON.stringify(output) + ')) writeFileSync(path, text);\n');
  f.git('add', '-A');
  f.git('-c', 'user.name=QE Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Candidate fixture');
  f.git('remote', 'add', 'origin', origin);
  const sha = f.git('rev-parse', 'HEAD');
  const logs = join(f.temp, 'npm-steps.jsonl');
  // Populate only the disposable npm cache with offline synthetic dependency
  // bytes. The candidate still uses real npm ci, build, test and pack.
  writeFileSync(join(f.temp, 'npm/bin/npm-cli.js'), [
    'const assert = require("node:assert/strict");',
    'const {appendFileSync, existsSync, readFileSync} = require("node:fs");',
    'const {spawnSync} = require("node:child_process");',
    'const cwd = process.cwd();',
    'const args = process.argv.slice(2);',
    'const run = args => spawnSync(process.execPath, [' + JSON.stringify(realNpm) + ', ...args], {encoding:"utf8"});',
    'appendFileSync(' + JSON.stringify(logs) + ', JSON.stringify({args, cwd}) + "\\n");',
    'assert.equal(readFileSync(".git/HEAD", "utf8").trim(), ' + JSON.stringify(sha) + ');',
    'assert(!existsSync(".env"));',
    'assert.equal(process.env.QEP_SYNTHETIC_CREDENTIAL, undefined);',
    'assert.equal(process.env.npm_config_ignore_scripts, "true");',
    'if (args[0] === "ci") {',
    '  assert(args.includes("--ignore-scripts"));',
    '  for (const path of ' + JSON.stringify(deps) + ') {',
    '    const result = run(["cache", "add", path]);',
    '    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(91); }',
    '  }',
    '  args.push("--offline");',
    '}',
    'const result = run(args);',
    'if (' + packIntegrity + ' && args[0] === "pack" && result.status === 0) {',
    '  const [item] = JSON.parse(result.stdout);',
    '  item.integrity = "sha512-wrong";',
    '  result.stdout = JSON.stringify([item]);',
    '}',
    'process.stdout.write(result.stdout); process.stderr.write(result.stderr);',
    'process.exitCode = result.status ?? 92;',
  ].join('\n'));
  f.env.QEP_SYNTHETIC_CREDENTIAL = 'excluded fixture variable';
  const npmVersion = JSON.parse(readFileSync(join(dirname(realNpm), '../package.json'))).version;
  writeFileSync(join(f.temp, 'npm/package.json'), JSON.stringify({ name: 'npm', version: npmVersion }));
  const candidate = join(f.cwd, '.local', 'consumer-gate', sha);
  return { ...f, sha, candidate, npmVersion,
    build: (source = f.source, commit = sha) => f.invoke(['build', '--source', source, '--sha', commit]),
    verify: (commit = sha) => f.invoke(['verify', '--sha', commit]),
    steps: () => existsSync(logs) ? readFileSync(logs, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('builds and verifies a private candidate from synthetic Git and retains exactly one archive', (t) => {
  const f = setup(t);
  const before = snapshot(f.source);
  const candidate = success(f.build(f.source, f.sha.toUpperCase()));
  assert.equal(candidate.producerSha, f.sha);
  assert.equal(candidate.name, manifest.name);
  assert.equal(candidate.version, manifest.version);
  assert.equal(candidate.npmVersion, f.npmVersion);
  assert.equal(candidate.buildCommand, manifest.scripts.build);
  assert.equal(candidate.unitCommand, manifest.scripts.test);
  assert.equal(candidate.archivePath, join(f.candidate, 'candidate.tgz'));
  assert.equal(candidate.receiptPath, join(f.candidate, 'receipt.json'));
  assert.deepEqual(readdirSync(f.candidate).sort(), ['candidate.tgz', 'receipt.json']);
  for (const path of [dirname(f.candidate), f.candidate]) assert.equal(lstatSync(path).mode & 0o777, 0o700);
  for (const path of [candidate.archivePath, candidate.receiptPath]) assert.equal(lstatSync(path).mode & 0o777, 0o400);
  const bytes = readFileSync(candidate.archivePath);
  assert.equal(candidate.size, bytes.length);
  assert.equal(candidate.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(candidate.integrity, integrity(bytes));
  assert.deepEqual(success(f.verify()), candidate);
  assert.deepEqual(f.steps().map(step => step.args), [
    ['--version'], ['ci', '--ignore-scripts', '--include=dev'], ['run', 'build', '--ignore-scripts'],
    ['test', '--ignore-scripts'], ['pack', '--ignore-scripts', '--json', '--pack-destination', join(f.candidate, 'work')],
  ]);
  assert(f.steps().every(step => step.cwd === join(f.candidate, 'work', 'workspace')));
  assertRejected(f.build(), /reservation already exists/);
  assert.equal(f.steps().length, 5);
  assert.deepEqual(readFileSync(candidate.archivePath), bytes);
  assert.deepEqual(snapshot(f.source), before);

  chmodSync(candidate.archivePath, 0o600);
  writeFileSync(candidate.archivePath, Buffer.concat([bytes, Buffer.from([0])]));
  assertRejected(f.verify(), /receipt or archive digest mismatch/);
  assertRejected(f.build(), /reservation already exists/);
  assert.equal(f.steps().length, 5);
  writeFileSync(candidate.archivePath, bytes);
  chmodSync(candidate.receiptPath, 0o600);
  const receipt = JSON.parse(readFileSync(candidate.receiptPath));
  writeFileSync(candidate.receiptPath, JSON.stringify({ ...receipt, integrity: integrity(Buffer.from('wrong')) }));
  assertRejected(f.verify(), /receipt or archive digest mismatch/);
  writeFileSync(candidate.receiptPath, JSON.stringify(receipt));
  rmSync(candidate.archivePath);
  symlinkSync(candidate.receiptPath, candidate.archivePath);
  assert.equal(f.verify().status, 2);
});

test('blocks missing inputs, a wrong SHA, dirty checkout, and an origin mismatch before npm', (t) => {
  const f = setup(t);
  assertRejected(f.invoke(['build', '--sha', f.sha]), /Supply candidate build/);
  assertRejected(f.build(f.source, f.sha.slice(0, 12)), /Supply candidate build/);
  assertRejected(f.build(f.source, '0'.repeat(40)), /HEAD does not match/);
  assertRejected(f.build('source'), /absolute paths/);
  writeFileSync(join(f.source, 'untracked'), 'fixture');
  assertRejected(f.build(), /working tree is dirty/);
  rmSync(join(f.source, 'untracked'));
  f.git('remote', 'set-url', 'origin', 'https://github.com/different/react-clu-component-lib.git');
  assertRejected(f.build(), /approved CLU repository/);
  f.git('remote', 'set-url', 'origin', origin);
  f.git('config', '--add', 'remote.origin.url', origin);
  assertRejected(f.build(), /approved CLU repository/);
  assert.deepEqual(f.steps(), []);
  assert.equal(existsSync(f.candidate), false);
});

for (const [name, change] of [
  ['changed build', { build: 'vite build' }],
  ['changed unit command', { test: 'vitest run --passWithNoTests' }],
  ['build lifecycle hook', { prebuild: 'exit 91' }],
  ['changed prepack', { prepack: 'exit 91' }],
  ['install lifecycle hook', { postinstall: 'exit 91' }],
]) {
  test('blocks ' + name + ' before any npm process', (t) => {
    const f = setup(t, { changeManifest: pkg => Object.assign(pkg.scripts, change) });
    assertRejected(f.build(), /unexpected build, unit or lifecycle scripts/);
    assert.deepEqual(f.steps(), []);
    assert.equal(existsSync(f.candidate), false);
  });
}

for (const [name, options, error, lastStep] of [
  ['missing generated output', { build: { 'dist/index.d.ts': null } }, /build output is missing/, 'run'],
  ['orphan declaration', { build: { 'dist/orphan.d.ts': 'export {};' } }, /unexpected package members/, 'pack'],
  ['embedded React', { build: { 'dist/index.js': esm + 'const __CLIENT_INTERNALS = {};\n' } }, /embedded React/, 'pack'],
  ['failed unit suite', { unit: 'fail' }, /unit suite failed/, 'test'],
  ['no positive unit evidence', { unit: 'missing' }, /missing-evidence/, 'test'],
  ['mismatched npm pack integrity', { packIntegrity: true }, /metadata does not match/, 'pack'],
]) {
  test('rejects ' + name + ' without retaining a candidate', (t) => {
    const f = setup(t, options);
    assertRejected(f.build(), error);
    assert.equal(f.steps().at(-1).args[0], lastStep);
    assert.equal(existsSync(f.candidate), false);
  });
}

test('rejects unsafe tar members before reading their package contents', () => {
  const baseline = Object.entries(files).map(([path, body]) => ({ path: 'package/' + path, body }));
  assert.equal(verifyCandidateArchive(tar(baseline)).members.size, baseline.length);
  for (const [member, error] of [
    [{ path: 'package/../outside', body: 'fixture' }, /Unsafe tar member path/],
    [{ path: '/package/outside', body: 'fixture' }, /Unsafe tar member path/],
    [{ path: 'package/extra', type: '2', link: '../outside' }, /Unsafe tar member type/],
    [{ path: 'package/extra', type: '1', link: 'package/README.md' }, /Unsafe tar member type/],
    [{ path: 'package/extra', type: 'x', body: 'PAX fixture' }, /Unsafe tar member type/],
    [baseline[0], /Duplicate or excessive tar members/],
    [{ path: 'package/node_modules/react/index.js', body: 'export {};' }, /unexpected package members/],
  ]) assert.throws(() => verifyCandidateArchive(tar([...baseline, member])), error);
});

test('rejects invalid manifest, declaration references, and credential-like member content', () => {
  for (const [path, body, error] of [
    ['package.json', JSON.stringify({ ...manifest, name: 'wrong' }), /name or version/],
    ['package.json', JSON.stringify({ ...manifest, version: 'not-semver' }), /name or version/],
    ['package.json', JSON.stringify({ ...manifest, exports: {} }), /export contract/],
    ['package.json', JSON.stringify({ ...manifest, peerDependencies: {} }), /React 19/],
    ['package.json', JSON.stringify({ ...manifest, bundleDependencies: ['react'] }), /bundled dependencies/],
    ['dist/index.d.ts', "export { Button } from '../../outside.js';", /escapes dist/],
    ['dist/index.d.ts', "export { Button } from './missing.js';", /graph is incomplete/],
    ['dist/index.d.ts', "export { Other } from './button.js';", /different public values/],
    ['dist/index.js', esm + 'const invalid = ;', /invalid candidate ESM/i],
    ['dist/index.js', esm + 'export default Button;', /named export declarations/],
    ['dist/styles.css', '.clu-dialog{}', /missing required CLU styles/],
    ['README.md', '-----BEGIN SYNTHETIC PRIVATE KEY-----', /credential-like content/],
  ]) {
    const members = Object.entries({ ...files, [path]: body }).map(([name, content]) => ({ path: 'package/' + name, body: content }));
    assert.throws(() => verifyCandidateArchive(tar(members)), error);
  }
});
