import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readManifest(path: string, label: string): Record<string, unknown> {
  try {
    if (!lstatSync(path).isFile()) throw new Error('Expected a regular file.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Expected a regular file.');
      const manifest: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (isRecord(manifest)) return manifest;
    } finally {
      closeSync(fd);
    }
  } catch {
    // Omit filesystem and parser errors, which may contain file contents.
  }
  throw new Error(`Cannot read ${label} as a regular JSON manifest.`);
}
