import { closeSync, constants, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { limitsV1, validRunId } from './result-contract-v1.js';

export type DgiLayer = 'backend' | 'frontend';
export const dgiLimits = Object.freeze({
  summaryBytes: 4096, manifestBytes: 2 * 1024 * 1024, caseBytes: 256 * 1024,
  junitBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
});
export const resultFilename = /^[a-f0-9]{64}-result\.json$/;

export class InvalidDgiEvidence extends Error {
  constructor(reason: string) { super('Invalid DGI evidence: ' + reason); }
}

export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new InvalidDgiEvidence(reason);
}

const qepRoot = resolve(import.meta.dirname, '..');
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (fd: number) => '/proc/self/fd/' + fd;

function entries(fd: number, limit: number): Set<string> {
  const names = new Set<string>();
  const dir = opendirSync(fdPath(fd));
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      check(names.size < limit && !names.has(entry.name), 'inventory size');
      names.add(entry.name);
    }
  } finally { dir.closeSync(); }
  return names;
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// Pin each parent while opening its child, so even a directory renamed to a
// symlink during collection cannot redirect subsequent reads. Linux procfs is
// already a prerequisite for QEP execution. The installation root is trusted.
export function withDgiWorkspace<T>(runId: string, inspect: (input: {
  summary: Buffer;
  batch: (layer: DgiLayer) => {
    manifest: Buffer;
    inventory: Set<string>;
    readResult: (name: string) => Buffer;
  };
  junit: (layer: DgiLayer) => Buffer | undefined;
}) => T): T {
  validRunId(runId);
  const directories: number[] = [];
  const watched = new Map<number, bigint>();
  let remaining: number = dgiLimits.totalBytes;
  let watchInventory = false;
  function directory(path: string, privateStorage = false) {
    const fd = openSync(path, readFlags | constants.O_DIRECTORY);
    directories.push(fd);
    const stat = fstatSync(fd, { bigint: true });
    check(stat.uid === BigInt(process.getuid!()) && (!privateStorage || !(stat.mode & 0o022n)), 'directory ownership');
    if (watchInventory) watched.set(fd, stat.ctimeNs);
    return fd;
  }
  function child(parent: number, name: string, privateStorage = false) {
    return directory(fdPath(parent) + '/' + name, privateStorage);
  }
  function file(parent: number, name: string, limit: number) {
    const fd = openSync(fdPath(parent) + '/' + name, readFlags);
    try {
      const before = fstatSync(fd, { bigint: true });
      check(before.isFile() && before.uid === BigInt(process.getuid!()) && before.nlink === 1n, 'file type or ownership');
      const size = Number(before.size);
      check(size > 0 && size <= Math.min(limit, remaining), 'file size');
      remaining -= size;
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = readSync(fd, bytes, offset, size - offset, null);
        check(count > 0, 'incomplete file');
        offset += count;
      }
      check(fstatSync(fd, { bigint: true }).ctimeNs === before.ctimeNs, 'file changed');
      return bytes;
    } finally { closeSync(fd); }
  }
  try {
    const local = directory(qepRoot + '/.local', true);
    const runs = child(local, 'runs', true);
    watchInventory = true;
    const run = child(runs, runId, true);
    check(!(fstatSync(run).mode & 0o077), 'run is not private');
    const summary = file(run, 'summary.json', dgiLimits.summaryBytes);
    const workspace = child(run, 'workspace');
    const result = inspect({
      summary,
      batch(layer) {
        check(layer === 'backend' || layer === 'frontend', 'layer');
        const results = child(child(workspace, 'artifacts'), 'allure-results');
        check(entries(results, 1).has(layer), 'mixed or missing layer');
        const scope = child(results, layer);
        check(entries(scope, 1).has('unit'), 'mixed or missing execution');
        const unit = child(scope, 'unit');
        const inventory = entries(unit, limitsV1.cases + 1);
        check(inventory.delete('dgi-manifest.json'), 'missing manifest');
        return { inventory, manifest: file(unit, 'dgi-manifest.json', dgiLimits.manifestBytes), readResult(name) {
          check(inventory.has(name) && name.length === 76 && resultFilename.test(name), 'result filename');
          return file(unit, name, dgiLimits.caseBytes);
        } };
      },
      junit(layer) {
        check(layer === 'backend' || layer === 'frontend', 'layer');
        try {
          return file(child(workspace, 'reports'), layer === 'backend' ? 'backend-unit.xml' : 'frontend.xml', dgiLimits.junitBytes);
        } catch (error) {
          if (missing(error)) return undefined;
          throw error;
        }
      },
    });
    for (const [fd, ctime] of watched) check(fstatSync(fd, { bigint: true }).ctimeNs === ctime, 'inventory changed');
    return result;
  } finally { for (const fd of directories.reverse()) closeSync(fd); }
}
