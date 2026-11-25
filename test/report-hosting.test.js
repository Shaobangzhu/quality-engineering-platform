import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compose = parse(read('../deploy/report-hosting/compose.yaml'));
const nginx = read('../deploy/report-hosting/nginx.conf');
const service = compose.services.nginx;

test('the hosting project publishes exactly one loopback TCP port on its own bridge', () => {
  assert.deepEqual(Object.keys(compose).sort(), ['name', 'services']);
  assert.equal(compose.name, 'qep-report-hosting');
  assert.deepEqual(Object.keys(compose.services), ['nginx']);
  assert.deepEqual(service.ports, [{
    host_ip: '127.0.0.1', published: '7300', target: 8080, protocol: 'tcp',
  }]);
  for (const option of ['extends', 'network_mode', 'networks', 'pid', 'ipc', 'devices', 'volumes_from']) {
    assert.equal(Object.hasOwn(service, option), false, option);
  }
});

test('the only bind mounts are read-only and require existing sources', () => {
  assert.deepEqual(service.volumes, [
    {
      type: 'bind', source: '/home/clu/infra/qep-report-site', target: '/srv/qep-public',
      read_only: true, bind: { create_host_path: false },
    },
    {
      type: 'bind', source: './nginx.conf', target: '/etc/nginx/nginx.conf',
      read_only: true, bind: { create_host_path: false },
    },
  ]);
});

test('Nginx starts directly under a non-root UID and has bounded writable storage and resources', () => {
  assert.equal(service.image,
    'ghcr.io/nginx/nginx-unprivileged:1.30.8-alpine3.24-slim@sha256:04c98c78c1de60ddeada00d7d2207dcd146ecd07b61b9941c9a5799cfb258d28');
  assert.deepEqual(service.entrypoint, ['nginx', '-g', 'daemon off;']);
  assert.equal(service.user, '101:101');
  assert.equal(service.read_only, true);
  assert.equal(service.privileged, false);
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.equal(Object.hasOwn(service, 'cap_add'), false);
  assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
  assert.deepEqual(service.tmpfs, ['/tmp:rw,noexec,nosuid,nodev,size=8m,mode=0700,uid=101,gid=101']);
  assert.equal(service.mem_limit, '64m');
  assert.equal(service.memswap_limit, service.mem_limit);
  assert.equal(service.cpus, 0.5);
  assert.equal(service.pids_limit, 32);
  assert.equal(service.restart, 'unless-stopped');
  assert.doesNotMatch(nginx, /^\s*user\s/m);
  assert.match(nginx, /^pid \/tmp\/nginx[.]pid;$/m);
  assert.deepEqual([...nginx.matchAll(/^\s*([a-z_]+_temp_path) (\S+);$/gm)].map(match => match[1]), [
    'client_body_temp_path', 'proxy_temp_path', 'fastcgi_temp_path', 'uwsgi_temp_path', 'scgi_temp_path',
  ]);
  assert.doesNotMatch(nginx, /_temp_path (?!\/tmp\/)/);
});

test('only GET and HEAD on the two literal report paths reach the static file', () => {
  const pathGuard = nginx.match(/if \(\$request_uri !~ "([^"]+)"\) \{\s+return 404;\s+\}/);
  const methodGuard = nginx.match(/if \(\$request_method !~ "([^"]+)"\) \{\s+return 403;\s+\}/);
  assert.ok(pathGuard && methodGuard);
  const pathAllowed = new RegExp(pathGuard[1]);
  const methodAllowed = new RegExp(methodGuard[1]);
  for (const path of ['/', '/index.html', '/?a=1', '/index.html?a=/report-manifest.json']) {
    assert.equal(pathAllowed.test(path), true, path);
  }
  for (const path of [
    '/report-manifest.json', '/summary.json', '/test-results.json', '/history.jsonl', '/manifest.json',
    '/.local/reports/index.html', '/current/index.html', '/releases/example/index.html', '/data/example',
    '//index.html', '/./index.html', '/releases/../index.html', '/%69ndex.html', '/index.html/', '/INDEX.HTML',
  ]) {
    assert.equal(pathAllowed.test(path), false, path);
  }
  assert.deepEqual(['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE'].filter(method => methodAllowed.test(method)),
    ['GET', 'HEAD']);
  assert.deepEqual([...nginx.matchAll(/^\s*location ([^\n{]+?) \{\s*([^{}]+)\}/gm)]
    .map(([, location, content]) => [location, content.trim()]), [
    ['= /', 'try_files /index.html =404;'],
    ['= /index.html', 'try_files /index.html =404;'],
    ['/', 'return 404;'],
  ]);
  assert.deepEqual([...nginx.matchAll(/^\s*listen ([^;]+);$/gm)].map(match => match[1]), ['8080 default_server']);
  assert.match(nginx, /root \/srv\/qep-public\/current;/);
  assert.match(nginx, /disable_symlinks on from=\$document_root;/);
  assert.match(nginx, /autoindex off;/);
  assert.match(nginx, /open_file_cache off;/);
  assert.doesNotMatch(nginx, /^\s*(?:include|load_module|alias|error_page|rewrite|proxy_pass|sub_filter)\s/m);
});

test('the response policy disables caching and preserves the Allure single-file CSP', () => {
  assert.match(nginx, /server_tokens off;/);
  for (const [name, value] of [
    ['Cache-Control', 'no-store'], ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'], ['Referrer-Policy', 'no-referrer'],
  ]) {
    assert.ok(nginx.includes(`add_header ${name} "${value}" always;`), name);
  }
  const header = nginx.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
  const meta = read('../src/allure-generator.ts').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(header && meta);
  assert.deepEqual(header.split('; '), [
    ...meta.split('; '), "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ]);
});
