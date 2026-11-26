import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { reportFileLimits } from '../dist/report-output.js';
import { siteCli } from '../dist/site-cli.js';

const securityHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline' data:",
    'img-src data: blob:', 'font-src data:', 'connect-src data: blob:',
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; '),
};
const deniedPaths = [
  '/report-manifest.json', '/manifest.json', '/summary.json', '/test-results.json', '/history.jsonl',
  '/.env', '/.local/reports/index.html', '/current/index.html', '/releases/example/index.html',
  '/data/example', '//index.html', '/./index.html', '/releases/../index.html',
  '/%69ndex.html', '/index.html/', '/INDEX.HTML',
];
const reportPaths = ['/', '/index.html'];
const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyCurrent(args, reviewedId, verify) {
  const result = verify(['verify', ...args]);
  requireCheck(result.exitCode === 0, 'qe site verify failed. ' + result.stderr);
  const { status, reportId, target, index } = JSON.parse(result.stdout);
  requireCheck(status === 'verified' && reportId === reviewedId && target === 'releases/' + reviewedId,
    'The verified current release differs from the reviewed report ID.');
  requireCheck(index?.name === 'index.html' && Number.isSafeInteger(index.bytes) && index.bytes > 0 &&
    index.bytes <= reportFileLimits['index.html'] && /^[a-f0-9]{64}$/.test(index.sha256),
    'Invalid index.html digest from qe site verify.');
  return index;
}

function probe(request, method, path, status, index) {
  const label = method + ' ' + path;
  const writing = writeMethods.includes(method);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: 7300, path, method, agent: false,
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Accept-Encoding': 'identity',
        ...(writing ? { 'Content-Length': '0', 'If-Match': '"qep-hosting-smoke-no-match"' } : {}),
      },
    }, async response => {
      try {
        requireCheck(response.statusCode === status, 'expected HTTP ' + status + ', got ' + response.statusCode);
        for (const [name, expected] of Object.entries(securityHeaders)) {
          const values = response.headersDistinct[name];
          requireCheck(values?.length === 1 && values[0] === expected, 'missing or unexpected ' + name);
        }
        const isReport = status === 200;
        if (isReport) {
          const types = response.headersDistinct['content-type'];
          requireCheck(types?.length === 1 && /^text\/html(?:\s*;|$)/i.test(types[0]), 'expected Content-Type text/html');
          const encoding = response.headersDistinct['content-encoding'];
          requireCheck(!encoding || (encoding.length === 1 && encoding[0] === 'identity'), 'expected identity encoding');
        }
        const limit = method === 'HEAD' ? 0 : isReport ? index.bytes : 64 * 1024;
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          requireCheck(bytes <= limit, 'response exceeded the expected byte limit');
          hash.update(chunk);
        }
        const sha256 = hash.digest('hex');
        if (isReport && method === 'GET') {
          requireCheck(bytes === index.bytes && sha256 === index.sha256, 'HTTP body SHA-256 or size differs from verified index.html');
        }
        resolve(sha256);
      } catch (error) {
        response.destroy();
        reject(new Error(label + ' — ' + error.message));
      }
    });
    req.on('error', error => reject(new Error(label + ' — ' + error.message)));
  });
}

export async function hostingSmoke(args, { verify = siteCli, request = get } = {}) {
  const [option, reviewedId, ...selectors] = args;
  requireCheck(option === '--report-id' && /^[a-f0-9]{64}$/.test(reviewedId) && selectors.length > 0,
    'Usage: node scripts/hosting-smoke.js --report-id <reviewed-report-id> --run-id <uuid> [--run-id <uuid> ...]');
  const index = verifyCurrent(selectors, reviewedId, verify);
  for (const path of [...reportPaths, '/index.html?probe=1']) {
    await probe(request, 'GET', path, 200, index);
  }
  await probe(request, 'HEAD', '/index.html', 200, index);
  const generic = await probe(request, 'GET', '/not-found', 404, index);
  for (const path of [...deniedPaths, '/releases/' + reviewedId + '/index.html']) {
    requireCheck(await probe(request, 'GET', path, 404, index) === generic,
      'GET ' + path + ' — denial body differs from the generic 404');
  }
  for (const path of reportPaths) {
    for (const method of writeMethods) await probe(request, method, path, 403, index);
  }
  for (const path of reportPaths) await probe(request, 'GET', path, 200, index);
  const after = verifyCurrent(selectors, reviewedId, verify);
  requireCheck(index.bytes === after.bytes && index.sha256 === after.sha256, 'Verified index.html changed during the smoke checks.');
  return { status: 'passed', reportId: reviewedId, sha256: index.sha256, bytes: index.bytes };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await hostingSmoke(process.argv.slice(2))));
  } catch (error) {
    console.error('Hosting smoke failed. ' + error.message);
    process.exitCode = 1;
  }
}
