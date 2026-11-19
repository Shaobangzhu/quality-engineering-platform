import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkInstall, verifyDependencies } from '../dist/install-policy.js';
import { inspectDgiChain } from '../dist/run-policy.js';
import { auditedDgiSha, findSuite } from '../dist/suite-catalog.js';
import { TestEvidence } from '../dist/test-evidence.js';
import { approvedNpmrc } from '../dist/workspace-tree.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qe-policy-'));
  t.after(() => rmSync(root, { recursive: true }));
  return root;
}

function json(root, path, obj) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj));
}

const registry = (name, version = '1.0.0') => ({
  version, resolved: 'https://registry.npmjs.org/' + name + '/-/' + name.split('/').at(-1) + '-' + version + '.tgz',
  integrity: 'sha512-' + 'A'.repeat(86) + '==',
});

test('allows only the reviewed CLU npm settings with literal true values', () => {
  assert.equal(approvedNpmrc('save-exact=true\nengine-strict=true\nstrict-peer-deps=true\n'), true);
  assert.equal(approvedNpmrc('engine-strict=true\r\n'), true);
  for (const content of [
    '', 'engine-strict=true\nengine-strict=true\n', 'save-exact=false\n', 'engine-strict =true',
    'strict-peer-deps=\${CONFIG}', 'save-exact=true\nregistry=https://example.invalid',
    'save-exact=true\n//registry.npmjs.org/:_authToken=synthetic',
    'node-options=--require=/example.js', 'script-shell=/example.sh', 'strict-peer-deps[]=true',
    'save-exact=true\0', 'save-exact=true\n\n', 'save-exact=true\u2028',
  ]) assert.equal(approvedNpmrc(content), false, JSON.stringify(content));
});

const build = `node --input-type=module -e "import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true });" && tsc`;
const dgi = {
  name: 'delivery-geo-intelligence', workspaces: ['frontend', 'backend'],
  scripts: { 'test:backend:unit': 'npm run test:unit -w backend', 'test:frontend': 'npm test -w frontend' },
};
const backend = {
  name: 'backend', version: '0.1.0',
  scripts: { build, 'test:unit': 'npm run build && node test/run.mjs unit' },
};
const frontend = {
  name: 'frontend', version: '0.1.0',
  scripts: { test: 'node ../scripts/allure/run.mjs frontend unit run' },
};

test('only the approved DGI SHA and exact workspace command chains are eligible', t => {
  const root = fixture(t);
  json(root, 'backend/package.json', backend);
  json(root, 'frontend/package.json', frontend);
  const backendSuite = findSuite('dgi-backend-unit');
  const frontendSuite = findSuite('dgi-frontend-unit');
  assert.equal(inspectDgiChain(root, auditedDgiSha, backendSuite, dgi).format, 'node-spec');
  assert.equal(inspectDgiChain(root, auditedDgiSha, frontendSuite, dgi).toolWorkspace, 'frontend');
  assert.throws(() => inspectDgiChain(root, '0'.repeat(40), backendSuite, dgi), /unsupported-profile/);
  for (const command of ['npm run test:unit -w frontend', 'npm run test:integration -w backend',
    'npm run test:unit -w backend && node extra.js', 'npm run test:unit -w backend $(node extra.js)']) {
    const altered = { ...dgi, scripts: { ...dgi.scripts, 'test:backend:unit': command } };
    assert.throws(() => inspectDgiChain(root, auditedDgiSha, backendSuite, altered), /unsupported-profile/);
  }
  json(root, 'backend/package.json', { ...backend, scripts: { ...backend.scripts, build: build + '; npm run extra' } });
  assert.throws(() => inspectDgiChain(root, auditedDgiSha, backendSuite, dgi), /unsupported-profile/);
  json(root, 'backend/package.json', { ...backend, scripts: { ...backend.scripts, prebuild: 'node extra.js' } });
  assert.throws(() => inspectDgiChain(root, auditedDgiSha, backendSuite, dgi), /lifecycle-review/);
  json(root, 'frontend/package.json', { ...frontend, scripts: { test: 'node ../scripts/allure/run.mjs e2e chromium test' } });
  assert.throws(() => inspectDgiChain(root, auditedDgiSha, frontendSuite, dgi), /unsupported-profile/);
});

function workspaceLock() {
  return { lockfileVersion: 3, packages: {
    '': { workspaces: dgi.workspaces }, backend: { version: backend.version }, frontend: { version: frontend.version },
    'node_modules/backend': { resolved: 'backend', link: true },
    'node_modules/frontend': { resolved: 'frontend', link: true },
    'backend/node_modules/sample': registry('sample'),
  } };
}
const workspaceProfile = { manifest: dgi, workspaceManifests: new Map([['backend', backend], ['frontend', frontend]]), tool: 'node' };
const cluProfile = { manifest: { name: '@shaobangzhu/clu-ui' }, workspaceManifests: new Map(), tool: 'node' };

test('checks npm v3 workspace entries and rejects unapproved links, registries and local specs', t => {
  const root = fixture(t);
  const read = lock => {
    json(root, 'package-lock.json', lock);
    return checkInstall(root, workspaceProfile);
  };
  assert.deepEqual(read(workspaceLock()).roots, ['node_modules', 'backend/node_modules', 'frontend/node_modules']);
  const alterations = [
    ['node_modules/frontend', { resolved: '../frontend', link: true }],
    ['node_modules/backend', { resolved: 'frontend', link: true }],
    ['node_modules/other', { resolved: 'backend', link: true }],
    ['node_modules/sample', { ...registry('sample'), resolved: 'file:../sample' }],
    ['node_modules/sample', { ...registry('sample'), resolved: 'https://example.invalid/sample.tgz' }],
    ['node_modules/sample', { ...registry('sample'), dependencies: { surprise: 'file:../../external' } }],
    ['node_modules/sample', { ...registry('sample'), workspaces: ['../../external'] }],
    ['other/node_modules/sample', registry('sample')],
    ['node_modules/sample', { ...registry('sample'), inBundle: true }],
  ];
  for (const [path, entry] of alterations) {
    const lock = workspaceLock();
    lock.packages[path] = entry;
    assert.throws(() => read(lock), /unsupported-install/, path);
  }
  const lock = workspaceLock();
  lock.packages['backend/node_modules/sample'].hasInstallScript = true;
  assert.doesNotThrow(() => read(lock));
  lock.packages['backend/node_modules/sample'].resolved = 'file:../external';
  assert.throws(() => read(lock), /unsupported-install/);
  json(root, 'package-lock.json', workspaceLock());
  assert.throws(() => checkInstall(root, { ...workspaceProfile, manifest: { ...dgi, overrides: { sample: 'file:../outside' } } }),
    /unsupported-install/);
  const hooked = new Map(workspaceProfile.workspaceManifests);
  hooked.set('backend', { ...backend, scripts: { postinstall: 'node install.js' } });
  assert.throws(() => checkInstall(root, { ...workspaceProfile, workspaceManifests: hooked }), /lifecycle-review/);
});

test('recognizes only the bundled dependencies from the reviewed CLU registry archive', t => {
  const root = fixture(t);
  const path = 'node_modules/@tailwindcss/oxide-wasm32-wasi';
  const child = path + '/node_modules/tslib';
  const lock = { lockfileVersion: 3, packages: {
    '': {},
    [path]: { ...registry('@tailwindcss/oxide-wasm32-wasi', '4.3.4'), bundleDependencies: ['tslib'],
      integrity: 'sha512-bjO9WmoM687p8AoCIyw1DUqzpAs4JICLvNmIPxIWDmhw8IOsdubtWQLShyJmISnDKtRy1BBApHVOUl6sNFQQJA==' },
    [child]: { version: '2.8.1', inBundle: true, optional: true },
  } };
  json(root, 'package-lock.json', lock);
  assert.ok(checkInstall(root, cluProfile).entries.has(child));
  lock.packages[child].resolved = 'file:../../elsewhere';
  json(root, 'package-lock.json', lock);
  assert.throws(() => checkInstall(root, cluProfile), /unsupported-install/);
});

test('third-party lifecycle metadata leaves registry and integrity checks in effect', t => {
  const root = fixture(t);
  const path = 'node_modules/sample';
  const lock = { lockfileVersion: 3, packages: {
    '': {}, [path]: { ...registry('sample'), hasInstallScript: true },
  } };
  json(root, 'package-lock.json', lock);
  assert.ok(checkInstall(root, cluProfile).entries.has(path));
  lock.packages[path].integrity = 'invalid';
  json(root, 'package-lock.json', lock);
  assert.throws(() => checkInstall(root, cluProfile), /unsupported-install/);
});

test('post-install verification requires exact local links and lock-declared dependency directories', t => {
  const root = fixture(t);
  const profile = { ...workspaceProfile, workspaceManifests: new Map([
    ['backend', { ...backend, dependencies: { sample: '1.0.0' } }], ['frontend', frontend],
  ]) };
  json(root, 'package-lock.json', workspaceLock());
  const installation = checkInstall(root, profile);
  json(root, 'backend/node_modules/sample/package.json', { name: 'sample', version: '1.0.0' });
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'frontend'));
  symlinkSync('../backend', join(root, 'node_modules/backend'));
  symlinkSync('../frontend', join(root, 'node_modules/frontend'));
  assert.doesNotThrow(() => verifyDependencies(root, profile, installation));
  json(root, 'backend/node_modules/sample/package.json', { name: 'sample', version: '2.0.0' });
  assert.throws(() => verifyDependencies(root, profile, installation), /integrity/);
  json(root, 'backend/node_modules/sample/package.json', { name: 'sample', version: '1.0.0' });
  writeFileSync(join(root, 'backend/node_modules/unexpected.cjs'), '');
  assert.throws(() => verifyDependencies(root, profile, installation), /integrity/);
  rmSync(join(root, 'backend/node_modules/unexpected.cjs'));
  rmSync(join(root, 'node_modules/backend'));
  symlinkSync('../frontend', join(root, 'node_modules/backend'));
  assert.throws(() => verifyDependencies(root, profile, installation), /integrity/);
});

test('audited backend spec footer requires consecutive, consistent and positive counts', () => {
  const footer = 'ℹ tests 3\nℹ suites 1\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 23.1\n';
  const result = (text, format = 'node-spec') => {
    const evidence = new TestEvidence(format);
    evidence.add(text.slice(0, 35));
    evidence.add(text.slice(35));
    return evidence.result();
  };
  assert.equal(result('✔ example (1.0ms)\n' + footer), 'passed');
  assert.equal(result(footer, 'standard'), 'missing');
  assert.equal(result('PASS\nTests  1 passed (1)\n'), 'missing');
  assert.equal(result(footer.replace('ℹ suites 1\n', '')), 'missing');
  assert.equal(result(footer.replace('ℹ pass 2', 'ℹ pass 1')), 'failed');
  assert.equal(result(footer.replace('ℹ cancelled 0', 'ℹ cancelled 1')), 'failed');
  assert.equal(result(footer + 'ℹ tests 3\n'), 'failed');
  assert.equal(result(footer.replace('ℹ pass 2', 'ℹ pass 0').replace('ℹ skipped 1', 'ℹ skipped 3')), 'missing');
});
