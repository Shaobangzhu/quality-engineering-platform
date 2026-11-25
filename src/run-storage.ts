import { closeSync, constants, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { validRunId } from './result-contract-v1.js';

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error('Invalid run storage: ' + reason);
}

function component(name: string) {
  check(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name), 'path component');
}

export type LocalStorage = {
  local: number;
  child(parent: number, name: string, privateStorage?: boolean): number;
  file(parent: number, name: string, limit: number): Buffer;
};

export type RunStorage = Omit<LocalStorage, 'local'> & {
  run: number;
  verifyInventory(): void;
};

export const localRoot = resolve(import.meta.dirname, '../.local');
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
export function withLocalStorage<T>(inspect: (storage: LocalStorage) => T): T {
  const directories: number[] = [];
  function directory(path: string, privateStorage = false) {
    const fd = openSync(path, readFlags | constants.O_DIRECTORY);
    directories.push(fd);
    const stat = fstatSync(fd, { bigint: true });
    check(stat.uid === BigInt(process.getuid!()) && (!privateStorage || !(stat.mode & 0o022n)), 'directory ownership');
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
    return inspect({ local: directory(localRoot, true), child, file });
  } finally { for (const fd of directories.reverse()) closeSync(fd); }
}

export function requirePrivateDirectory(fd: number) {
  check(!(fstatSync(fd).mode & 0o077), 'directory is not private');
}

export function withRun<T>(runId: string, inspect: (storage: RunStorage) => T): T {
  validRunId(runId);
  return withLocalStorage(storage => {
    const runs = storage.child(storage.local, 'runs', true);
    const watched = new Map<number, bigint>();
    function child(parent: number, name: string, privateStorage = false) {
      const fd = storage.child(parent, name, privateStorage);
      watched.set(fd, fstatSync(fd, { bigint: true }).ctimeNs);
      return fd;
    }
    const run = child(runs, runId, true);
    requirePrivateDirectory(run);
    return inspect({ run, child, file: storage.file, verifyInventory() {
      for (const [fd, ctime] of watched) check(fstatSync(fd, { bigint: true }).ctimeNs === ctime, 'inventory changed');
    } });
  });
}
