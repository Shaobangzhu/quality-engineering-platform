import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
export const dgi = { name: 'delivery-geo-intelligence', scripts: { 'test:backend:unit': 'exit 99', 'test:frontend': 'exit 99' } };
export const clu = { name: '@shaobangzhu/clu-ui', scripts: { test: 'exit 99' } };

export function fixture(t, manifest = dgi, command = 'plan') {
  const temp = mkdtempSync(join(tmpdir(), 'qe-fixture-'));
  const owned = lstatSync(temp);
  t.after(() => {
    const current = lstatSync(temp);
    assert.ok(current.isDirectory() && current.uid === process.getuid() &&
      current.dev === owned.dev && current.ino === owned.ino, 'fixture directory ownership changed');
    rmSync(temp, { recursive: true });
  });
  const source = join(realpathSync(temp), 'source with spaces');
  const cwd = join(temp, 'qep');
  mkdirSync(source);
  mkdirSync(cwd);
  let entry = cli;
  if (command === 'workspace') {
    // Exercise the installed CLI's module-relative default in a temporary QEP root.
    cpSync(new URL('../dist/', import.meta.url), join(cwd, 'dist'), { recursive: true });
    cpSync(new URL('../package.json', import.meta.url), join(cwd, 'package.json'));
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(cwd, 'node_modules'));
    entry = join(cwd, 'dist/cli.js');
  }
  const git = (...args) => execFileSync('git', args, {
    cwd: source, encoding: 'utf8', env: {
      PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
  git('init', '-q');
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, '.gitignore'), '.env\n');
  writeFileSync(join(source, '.env'), 'synthetic fixture data\n', { mode: 0o000 });
  git('add', 'package.json', '.gitignore');
  git('-c', 'user.name=QE Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
  const sha = git('rev-parse', 'HEAD');

  const npm = join(temp, 'npm');
  mkdirSync(join(npm, 'bin'), { recursive: true });
  const launcher = join(npm, 'bin', 'npm-cli.js');
  writeFileSync(launcher, '#!/bin/sh\ntouch unexpectedly-ran-npm\nexit 99\n', { mode: 0o755 });
  symlinkSync(launcher, join(npm, 'bin', 'npm'));
  writeFileSync(join(npm, 'package.json'), JSON.stringify({ name: 'npm', version: '10.9.9' }));
  const env = { ...process.env, PATH: `${join(npm, 'bin')}${delimiter}${process.env.PATH}` };
  const invoke = (args) => {
    const { status, stdout, stderr, error } = spawnSync(process.execPath, [entry, command, ...args], {
      cwd: command === 'workspace' ? temp : cwd, env, encoding: 'utf8',
    });
    assert.ifError(error);
    return { status, stdout, stderr };
  };
  const plan = ({ suite = 'dgi-backend-unit', path = source, commit = sha, extra = ['--json'] } = {}) =>
    invoke(['--suite', suite, '--source', path, '--sha', commit, ...extra]);
  return { source, sha, cwd, git, plan, env, invoke, temp };
}

export function snapshot(directory) {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path, { bigint: true });
    const metadata = [name, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs];
    if (stat.isDirectory()) return [...metadata, snapshot(path)];
    if (stat.isSymbolicLink()) return [...metadata, readlinkSync(path)];
    return name === '.env' ? metadata : [...metadata, readFileSync(path)];
  });
}

export function assertRejected(result, message) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
}
