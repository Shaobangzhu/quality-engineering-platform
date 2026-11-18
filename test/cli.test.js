import assert from 'node:assert/strict';
import { test } from 'node:test';
import packageMetadata from '#package' with { type: 'json' };
import { runCli } from '../dist/run-cli.js';

test('shows help with no arguments, help, or --help', () => {
  for (const args of [[], ['help'], ['--help']]) {
    const { exitCode, stdout, stderr } = runCli(args);
    assert.equal(exitCode, 0);
    assert.match(stdout, /^Usage: qe /);
    assert.match(stdout, /--version/);
    assert.equal(stderr, undefined);
  }
});

test('prints the package version', () => {
  assert.deepEqual(runCli(['--version']), { exitCode: 0, stdout: packageMetadata.version });
});

test('rejects an unknown command', () => {
  const { exitCode, stdout, stderr } = runCli(['unknown']);
  assert.equal(exitCode, 2);
  assert.equal(stdout, undefined);
  assert.match(stderr, /Unknown command "unknown"/);
  assert.match(stderr, /qe help/);
});

test('rejects an unexpected argument', () => {
  const { exitCode, stdout, stderr } = runCli(['help', 'extra']);
  assert.equal(exitCode, 2);
  assert.equal(stdout, undefined);
  assert.match(stderr, /Unexpected argument "extra"/);
  assert.match(stderr, /qe help/);
});
