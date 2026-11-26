import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { valid } from 'semver';
import ts from 'typescript';
import { isRecord } from './metadata.js';
import { parseStrictJson } from './strict-json.js';

export const cluPackage = '@shaobangzhu/clu-ui';
export const archiveLimit = 8 * 1024 * 1024;
export const jsonLimit = 256 * 1024;
const block = 512;
const esm = 'dist/index.js';
const types = 'dist/index.d.ts';
const css = 'dist/styles.css';
export const requiredMembers = ['package.json', 'README.md', 'LICENSE', esm, types, css];
const decoder = new TextDecoder('utf-8', { fatal: true });
const credentials = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:proj-)?[a-z0-9_-]{30,}|npm_[a-z0-9]{30,}|xox[baprs]-[a-z0-9-]{10,})\b|(?:_authToken|aws_secret_access_key|client_secret|api_key|password)\s*["']?\s*[:=]\s*["']?[0-9a-z/+_=-]{16,}|https?:\/\/[^\s/:]+:[^\s/@]+@/i;

function requireContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function exactVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value) && valid(value) !== null;
}

export function checkPackageManifest(manifest: unknown): asserts manifest is Record<string, unknown> & { version: string } {
  requireContract(isRecord(manifest) && manifest.name === cluPackage && exactVersion(manifest.version),
    'Invalid CLU package name or version.');
  requireContract(manifest.type === 'module' && manifest.private === false && manifest.license === 'MIT' &&
    manifest.main === './' + esm && manifest.module === manifest.main && manifest.types === './' + types &&
    isDeepStrictEqual(manifest.exports, { '.': { types: './' + types, import: './' + esm }, './styles.css': './' + css }) &&
    isDeepStrictEqual(manifest.sideEffects, ['./' + css]) &&
    ['bin', 'man', 'browser', 'typesVersions', 'workspaces'].every(key => !Object.hasOwn(manifest, key)),
  'Invalid CLU ESM, declaration or CSS export contract.');
  requireContract(isDeepStrictEqual(manifest.peerDependencies, { react: '^19.0.0' }) &&
    ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'peerDependenciesMeta']
      .every(key => !Object.hasOwn(manifest, key)),
  'CLU must use React 19 as its only runtime peer without bundled dependencies.');
  requireContract(isDeepStrictEqual(manifest.files, ['dist/**/*.d.ts', esm, css]),
    'Invalid CLU package files configuration.');
}

export function archiveDigests(bytes: Buffer) {
  return {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  };
}

const allZero = (bytes: Buffer) => bytes.every(value => value === 0);

function tarField(field: Buffer) {
  const end = field.indexOf(0);
  requireContract(end === -1 || allZero(field.subarray(end)), 'Invalid tar header field.');
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function tarOctal(field: Buffer) {
  const value = field.toString('latin1');
  requireContract(/^[0-7]+[\0 ]+$/.test(value), 'Invalid tar numeric field.');
  return Number.parseInt(value, 8);
}

// Read the portable regular-file USTAR subset emitted for the CLU inventory.
// Extensions which can reinterpret paths, links, and other member types fail closed.
function tarMembers(archive: Buffer) {
  requireContract(archive.length > 0 && archive.length <= archiveLimit, 'Invalid candidate archive size.');
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 }); }
  catch { throw new Error('Invalid candidate gzip archive.'); }
  const members = new Map<string, Buffer>();
  for (let offset = 0; offset + block <= tar.length;) {
    const header = tar.subarray(offset, offset + block);
    if (allZero(header)) {
      requireContract(tar.length % block === 0 && tar.length - offset >= 2 * block && allZero(tar.subarray(offset)),
        'Invalid tar end marker.');
      return members;
    }
    const expected = tarOctal(header.subarray(148, 156));
    let checksum = 0;
    for (const [index, value] of header.entries()) checksum += index >= 148 && index < 156 ? 32 : value;
    requireContract(checksum === expected && header.subarray(257, 265).equals(Buffer.from('ustar\0' + '00')),
      'Invalid USTAR header.');
    requireContract((header[156] === 48 || header[156] === 0) && allZero(header.subarray(157, 257)),
      'Unsafe tar member type or link.');
    const name = tarField(header.subarray(0, 100));
    const prefix = tarField(header.subarray(345, 500));
    const path = prefix ? prefix + '/' + name : name;
    requireContract(path.startsWith('package/') && path.split('/').every(part =>
      /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'), 'Unsafe tar member path.');
    const member = path.slice('package/'.length);
    requireContract(!members.has(member) && members.size < 1024, 'Duplicate or excessive tar members.');
    const start = offset + block;
    const size = tarOctal(header.subarray(124, 136));
    offset = start + Math.ceil(size / block) * block;
    requireContract(size > 0 && offset <= tar.length && allZero(tar.subarray(start + size, offset)),
      'Invalid tar member size or padding.');
    members.set(member, tar.subarray(start, start + size));
  }
  throw new Error('Missing tar end marker.');
}

function checkModuleSyntax(paths: string[], texts: Map<string, string>) {
  const options: ts.CompilerOptions = {
    allowJs: true, noLib: true, noResolve: true, noEmit: true, types: [],
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  };
  const sources = new Map(paths.map(path => {
    const filename = '/' + path;
    return [filename, ts.createSourceFile(filename, texts.get(path)!, ts.ScriptTarget.ESNext, true)];
  }));
  const host = { ...ts.createCompilerHost(options), getSourceFile: (filename: string) => sources.get(filename) };
  const program = ts.createProgram([...sources.keys()], options, host);
  requireContract(program.getSyntacticDiagnostics().length === 0 && [...sources.values()].every(ts.isExternalModule),
    'Invalid candidate ESM or declaration syntax.');
  return { runtime: sources.get('/' + esm)!, declarations: sources.get('/' + types)! };
}

function exportedValues(source: ts.SourceFile) {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) {
      requireContract(!ts.isExportAssignment(statement) && !(ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)),
      'Candidate public entry must use named export declarations.');
      continue;
    }
    if (statement.isTypeOnly) continue;
    requireContract(statement.exportClause && ts.isNamedExports(statement.exportClause),
      'Candidate public entry must use named exports.');
    for (const entry of statement.exportClause.elements) if (!entry.isTypeOnly) names.push(entry.name.text);
  }
  requireContract(names.length === new Set(names).size, 'Candidate public entry contains duplicate exports.');
  return names.sort();
}

function hasDynamicImport(node: ts.Node): boolean {
  return (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
    Boolean(node.forEachChild(child => hasDynamicImport(child) || undefined));
}

export function verifyCandidateArchive(archive: Buffer) {
  const members = tarMembers(archive);
  requireContract(requiredMembers.every(path => members.has(path)), 'Candidate archive is missing required package members.');
  const manifest = parseStrictJson(members.get('package.json')!, jsonLimit, 32, 4096);
  checkPackageManifest(manifest);
  const texts = new Map<string, string>();
  for (const [path, bytes] of members) {
    const text = decoder.decode(bytes);
    requireContract(text.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) && !credentials.test(text),
      'Candidate contains non-text or credential-like content.');
    requireContract(!path.startsWith('dist/') || !/sourceMappingURL|sourceURL=|@import|@font-face/.test(text),
      'Candidate contains an unexpected distribution reference.');
    texts.set(path, text);
  }

  const allowed = new Set(requiredMembers);
  const pending = [types];
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const text = texts.get(path);
    requireContract(text, 'Candidate public declaration graph is incomplete.');
    const references = ts.preProcessFile(text);
    requireContract(!references.referencedFiles.length && !references.libReferenceDirectives.length &&
      references.typeReferenceDirectives.every(entry => entry.fileName === 'react'),
    'Candidate declarations reference unexpected files.');
    for (const { fileName } of references.importedFiles) {
      if (fileName === 'react') continue;
      requireContract(/^\.\.?\/(?:[\w.-]+\/)*[\w.-]+\.js$/.test(fileName),
        'Candidate declarations reference an unexpected dependency.');
      const target = posix.join(posix.dirname(path), fileName.slice(0, -3) + '.d.ts');
      requireContract(target.startsWith('dist/'), 'Candidate declaration reference escapes dist.');
      allowed.add(target);
      pending.push(target);
    }
  }
  requireContract(members.size === allowed.size && [...allowed].every(path => members.has(path)),
    'Candidate archive contains unexpected package members.');

  const js = texts.get(esm)!;
  const imports = ts.preProcessFile(js, true, true).importedFiles;
  const { runtime, declarations } = checkModuleSyntax([esm, ...visited], texts);
  requireContract(imports.length > 0 && imports.every(({ fileName }) => /^react(?:\/jsx-(?:dev-)?runtime)?$/.test(fileName)) &&
    runtime.statements.some(ts.isImportDeclaration) && !hasDynamicImport(runtime) &&
    !/__CLIENT_INTERNALS|__SECRET_INTERNALS|react\.production|react\.development|requireReact|Symbol\.for\(["']react\.|\b(?:module\.exports|require\s*\()/.test(js),
  'Candidate ESM must import external React without embedded React internals.');
  const names = exportedValues(runtime);
  requireContract(names.length && isDeepStrictEqual(names, exportedValues(declarations)),
    'Candidate ESM and declarations expose different public values.');
  const styles = texts.get(css)!;
  requireContract(['--clu-', '.clu-dialog', '.clu-table'].every(marker => styles.includes(marker)),
    'Candidate CSS is missing required CLU styles.');

  return { manifest, members, ...archiveDigests(archive) };
}
