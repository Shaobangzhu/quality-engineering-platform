import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostingSmoke } from '../scripts/hosting-smoke.js';
import { syntheticHosting } from './fixtures/hosting-http.js';

const html = Buffer.from('<html>synthetic report</html>');
const digest = createHash('sha256').update(html).digest('hex');
const id = 'a'.repeat(64);
const selectors = ['--run-id', 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa'];
const args = ['--report-id', id, ...selectors];
const verified = {
  status: 'verified', reportId: id, target: 'releases/' + id,
  index: { name: 'index.html', bytes: html.length, sha256: digest },
};
const result = (data = verified) => ({ exitCode: 0, stdout: JSON.stringify(data) });
const verify = () => result();

test('smoke sends direct, literal requests and verifies the launch before and after writes', async () => {
  const { request, calls } = syntheticHosting(html);
  const verificationPoints = [];
  const report = await hostingSmoke(args, { request, verify(options) {
    assert.deepEqual(options, ['verify', ...selectors]);
    verificationPoints.push(calls.length);
    return result();
  } });
  assert.deepEqual(report, { status: 'passed', reportId: id, sha256: digest, bytes: html.length });
  assert.deepEqual(verificationPoints, [0, calls.length]);
  assert.deepEqual(calls.slice(0, 4).map(({ method, path }) => method + ' ' + path),
    ['GET /', 'GET /index.html', 'GET /index.html?probe=1', 'HEAD /index.html']);
  for (const path of [
    '/.env', '/summary.json', '/history.jsonl', '//index.html', '/./index.html', '/%69ndex.html',
    '/releases/' + id + '/index.html',
  ]) {
    assert.ok(calls.some(call => call.method === 'GET' && call.path === path), path);
  }
  assert.deepEqual(calls.slice(-10).map(({ method, path }) => method + ' ' + path), [
    'POST /', 'PUT /', 'PATCH /', 'DELETE /',
    'POST /index.html', 'PUT /index.html', 'PATCH /index.html', 'DELETE /index.html',
    'GET /', 'GET /index.html',
  ]);
  for (const { hostname, port, agent, signal, headers, method } of calls) {
    assert.deepEqual([hostname, port, agent], ['127.0.0.1', 7300, false]);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(headers['Accept-Encoding'], 'identity');
    if (!['GET', 'HEAD'].includes(method)) {
      assert.equal(headers['Content-Length'], '0');
      assert.equal(headers['If-Match'], '"qep-hosting-smoke-no-match"');
    }
  }
});

test('smoke fails before HTTP when site verification fails or identifies another report', async () => {
  const request = () => assert.fail('Unexpected HTTP request');
  await assert.rejects(hostingSmoke(args, { request, verify: () => ({
    exitCode: 2, stderr: 'Site current release is missing.',
  }) }), /qe site verify failed.*missing/);
  await assert.rejects(hostingSmoke(['--report-id', 'b'.repeat(64), ...selectors], { request, verify }),
    /differs from the reviewed report ID/);
});

test('smoke rejects malformed invocation with a nonzero exit and no stdout', () => {
  const script = fileURLToPath(new URL('../scripts/hosting-smoke.js', import.meta.url));
  const cli = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /Usage:/);
});

test('smoke rejects a changed verified index after the HTTP probes', async () => {
  const { request, calls } = syntheticHosting(html);
  await assert.rejects(hostingSmoke(args, { request, verify: () => result(calls.length
    ? { ...verified, index: { ...verified.index, sha256: '0'.repeat(64) } }
    : verified) }), /changed during the smoke checks/);
});

test('smoke fails closed on bad HTTP responses', async t => {
  const scenarios = [
    ['unrelated HTML of the same size', 'GET /', r => { r.body = Buffer.alloc(html.length, 'x'); }, /SHA-256/],
    ['oversized HTML', 'GET /', r => { r.body = Buffer.concat([html, Buffer.from('x')]); }, /byte limit/],
    ['wrong MIME type', 'GET /index.html', r => { r.headersDistinct['content-type'] = ['text/plain']; }, /text\/html/],
    ['unexpected encoding', 'GET /', r => { r.headersDistinct['content-encoding'] = ['gzip']; }, /identity encoding/],
    ['unsupported HEAD', 'HEAD /index.html', r => { r.statusCode = 405; }, /HTTP 200, got 405/],
    ['redirect', 'GET /', r => { r.statusCode = 302; }, /HTTP 200, got 302/],
    ['missing header', 'GET /', r => { delete r.headersDistinct['referrer-policy']; }, /referrer-policy/],
    ['duplicate header', 'GET /', r => { r.headersDistinct['cache-control'].push('no-store'); }, /cache-control/],
    ['weaker CSP', 'GET /', r => { r.headersDistinct['content-security-policy'] = ['default-src *']; }, /content-security-policy/],
    ['missing header on denial', 'GET /not-found', r => { delete r.headersDistinct['x-frame-options']; }, /x-frame-options/],
    ['allowed sensitive path', 'GET /.env', r => { r.statusCode = 200; }, /HTTP 404, got 200/],
    ['served direct release URL', 'GET /releases/' + id + '/index.html', r => {
      r.statusCode = 200;
      r.body = html;
    }, /HTTP 404, got 200/],
    ['leaky denial', 'GET /.env', r => { r.body = Buffer.from('synthetic secret'); }, /generic 404/],
    ['allowed write', 'PUT /index.html', r => { r.statusCode = 204; }, /HTTP 403, got 204/],
    ['changed report after writes', 'GET /index.html', (r, n) => {
      if (n > 4) r.body = Buffer.alloc(html.length, 'x');
    }, /SHA-256/],
    ['transport failure', 'GET /', () => new Error('synthetic connection failure'), /synthetic connection failure/],
  ];
  for (const [name, target, change, expected] of scenarios) {
    await t.test(name, async () => {
      const { request } = syntheticHosting(html, (reply, { method, path }, n) => {
        if (target === method + ' ' + path) return change(reply, n);
      });
      await assert.rejects(hostingSmoke(args, { request, verify }), error => {
        assert.ok(error.message.startsWith(target + ' — '));
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /synthetic secret/);
        return true;
      });
    });
  }
});
