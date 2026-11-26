import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const nginx = readFileSync(new URL('../../deploy/report-hosting/nginx.conf', import.meta.url), 'utf8');
const headers = Object.fromEntries([...nginx.matchAll(/add_header (\S+) "([^"]+)" always;/g)]
  .map(([, name, value]) => [name.toLowerCase(), [value]]));

export function syntheticHosting(html, change = () => {}) {
  const calls = [];
  const request = (options, onResponse) => {
    calls.push(options);
    const req = new EventEmitter();
    const { path, method } = options;
    const allowed = /^\/(index[.]html)?(\?.*)?$/.test(path);
    const statusCode = !allowed ? 404 : ['GET', 'HEAD'].includes(method) ? 200 : 403;
    const reply = {
      statusCode,
      headersDistinct: { ...structuredClone(headers), 'content-type': ['text/html'] },
      body: statusCode === 200 ? html : Buffer.from('generic error ' + statusCode),
    };
    if (method === 'HEAD') reply.body = Buffer.alloc(0);
    queueMicrotask(() => {
      const error = change(reply, options, calls.length);
      if (error) {
        req.emit('error', error);
        return;
      }
      const mid = Math.floor(reply.body.length / 2);
      const response = Readable.from([reply.body.subarray(0, mid), reply.body.subarray(mid)]);
      onResponse(Object.assign(response, reply, { body: undefined }));
    });
    return req;
  };
  return { request, calls };
}
