import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function lockRuntime(runs: string) {
  const path = join(runs, 'execution.lock');
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Runtime locked by another execution or an interrupted run.');
    throw error;
  }
  // Keep the inode pinned so removal and replacement cannot recycle its identity.
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const owner = fstatSync(fd, { bigint: true });
  return (cleanupVerified: boolean) => {
    try {
      if (!cleanupVerified) return;
      const current = lstatSync(path, { bigint: true });
      if (current.ino !== owner.ino || current.dev !== owner.dev) throw new Error('Runtime lock ownership changed.');
      rmdirSync(path);
    } finally { closeSync(fd); }
  };
}

export function writeSummary(path: string, bytes: Buffer) {
  const pending = join(dirname(path), '.' + basename(path, '.json') + '.tmp');
  writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 });
  linkSync(pending, path);
  unlinkSync(pending);
}
