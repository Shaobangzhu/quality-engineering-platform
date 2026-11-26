import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const manifest = {
  name: '@shaobangzhu/clu-ui', version: '0.1.0-fixture.1', private: false, type: 'module', license: 'MIT',
  main: './dist/index.js', module: './dist/index.js', types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './styles.css': './dist/styles.css' },
  sideEffects: ['./dist/styles.css'], files: ['dist/**/*.d.ts', 'dist/index.js', 'dist/styles.css'],
  scripts: { build: 'vite build && node scripts/build-types.mjs', test: 'vitest run', prepack: 'npm run build' },
  peerDependencies: { react: '^19.0.0' }, devDependencies: { vite: '1.0.0', vitest: '1.0.0', react: '19.0.0' },
};
const esm = "import { createElement } from 'react';\nconst Button = () => createElement('button');\nexport { Button };\n";
export const files = {
  'package.json': JSON.stringify(manifest),
  'README.md': '# Synthetic CLU',
  LICENSE: 'MIT fixture license',
  'dist/index.js': esm,
  'dist/index.d.ts': "export { Button } from './button.js';\n",
  'dist/button.d.ts': 'export declare const Button: () => unknown;\n',
  'dist/styles.css': '.clu-dialog,.clu-table{--clu-color:#fff}',
};

export function tar(members) {
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

export const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
