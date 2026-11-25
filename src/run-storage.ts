import { closeSync, constants, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { validRunId } from './result-contract-v1.js';

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error('Invalid run storage: ' + reason);
}

function component(name: string) {
  check(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name), 'path component');
}

export type RunStorage = {
  run: number;
  child(parent: number, name: string, privateStorage?: boolean): number;
  file(parent: number, name: string, limit: number): Buffer;
  verifyInventory(): void;
};

const qepRoot = resolve(import.meta.dirname, '..');
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const fdPath = (fd: number) => '/proc/self/fd/' + fd;

export function entries(fd: number, limit: number): Set<string> {
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

export function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// Pin each parent while opening its child, so even a directory renamed to a
// symlink during collection cannot redirect subsequent reads. Linux procfs is
// already a prerequisite for QEP execution. The installation root is trusted.
export function withRun<T>(runId: string, inspect: (storage: RunStorage) => T): T {
  validRunId(runId);
  const directories: number[] = [];
  const watched = new Map<number, bigint>();
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
    component(name);
    return directory(fdPath(parent) + '/' + name, privateStorage);
  }
  function file(parent: number, name: string, limit: number) {
    component(name);
    const fd = openSync(fdPath(parent) + '/' + name, readFlags);
    try {
      const before = fstatSync(fd, { bigint: true });
      check(before.isFile() && before.uid === BigInt(process.getuid!()) && before.nlink === 1n, 'file type or ownership');
      const size = Number(before.size);
      check(size > 0 && size <= limit, 'file size');
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
    return inspect({ run, child, file, verifyInventory() {
      for (const [fd, ctime] of watched) check(fstatSync(fd, { bigint: true }).ctimeNs === ctime, 'inventory changed');
    } });
  } finally { for (const fd of directories.reverse()) closeSync(fd); }
}
