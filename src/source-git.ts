import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const gitEnvironment = {
  PATH: (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute).join(delimiter),
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_ALLOW_PROTOCOL: '',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, args: readonly string[], label: string): string {
  try {
    const output = execFileSync('git', [
      '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects',
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null',
      '-C', cwd, ...args,
    ], {
      cwd: '/',
      env: gitEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    throw new Error(`Cannot check ${label} using Git.`);
  }
}

function requireSafeGitConfig(source: string): void {
  const gitDirectory = join(source, '.git');
  if (!lstatSync(gitDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Source must be the root of a Git checkout with a local .git directory.');
  }

  const config = join(gitDirectory, 'config');
  const objects = join(gitDirectory, 'objects');
  const objectInfo = join(objects, 'info');
  const metadataDirectories = ['info', 'objects/info', 'objects/pack', 'refs'];
  const metadataFiles = ['HEAD', 'index', 'packed-refs', 'info/exclude', 'info/attributes'];
  if (!lstatSync(config, { throwIfNoEntry: false })?.isFile() ||
      lstatSync(join(gitDirectory, 'commondir'), { throwIfNoEntry: false }) ||
      !lstatSync(objects, { throwIfNoEntry: false })?.isDirectory() ||
      metadataDirectories.some((directory) => {
        const stat = lstatSync(join(gitDirectory, directory), { throwIfNoEntry: false });
        return stat && !stat.isDirectory();
      }) ||
      lstatSync(join(objectInfo, 'alternates'), { throwIfNoEntry: false }) ||
      metadataFiles.some((file) => {
        const stat = lstatSync(join(gitDirectory, file), { throwIfNoEntry: false });
        return stat && !stat.isFile();
      })) {
    throw new Error('Source has unsupported Git metadata.');
  }

  // Parse only the local config, with discovery and includes disabled.
  const keys = git('/', ['config', '--file', config, '--no-includes', '--name-only', '--null', '--list'], 'source Git configuration');
  if (keys.split('\0').some((key) =>
    /^(?:include\.|includeif\.|core\.worktree$|extensions\.worktreeconfig$)/i.test(key))) {
    throw new Error('Source Git configuration uses includes or a separate worktree.');
  }
}

// Git reports the stat fields it cached in the index. A change to those fields
// is enough to reject the checkout without opening tracked files to hash them.
const indexEntry = /([^ ]) (100644|100755|120000|160000) [0-9a-f]{40} ([0-3])\t([^\0]+)\0  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: [0-9a-f]+\n/y;

function checkTrackedFiles(source: string, index: string): void {
  const dirty = 'Source working tree is dirty or its tracked-file metadata has changed.';
  for (let offset = 0; offset < index.length; offset = indexEntry.lastIndex) {
    indexEntry.lastIndex = offset;
    const entry = indexEntry.exec(index);
    if (!entry) throw new Error('Cannot inspect source Git index metadata.');
    const [, tag, mode, stage, file, ctimeSec, ctimeNs, mtimeSec, mtimeNs, dev, ino, uid, gid, size] = entry;
    if (tag !== 'H' || mode === '160000' || stage !== '0') {
      throw new Error('Source Git index contains submodules, conflicts, or hidden working-tree changes.');
    }

    const path = join(source, file);
    const parent = dirname(path);
    try {
      if (file.split('/').some((part) => part === '..' || part === '.' || !part) ||
          realpathSync(parent) !== parent) {
        throw new Error(dirty);
      }
      const stat = lstatSync(path, { bigint: true });
      const executable = (stat.mode & 0o100n) !== 0n;
      const expectedMode = stat.isSymbolicLink() ? '120000' : executable ? '100755' : '100644';
      const expectedCtime = BigInt(ctimeSec) * 1_000_000_000n + BigInt(ctimeNs);
      const expectedMtime = BigInt(mtimeSec) * 1_000_000_000n + BigInt(mtimeNs);
      const low32 = (value: bigint) => BigInt.asUintN(32, value);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || mode !== expectedMode ||
          stat.ctimeNs !== expectedCtime || stat.mtimeNs !== expectedMtime ||
          low32(stat.dev) !== BigInt(dev) || low32(stat.ino) !== BigInt(ino) ||
          stat.uid !== BigInt(uid) || stat.gid !== BigInt(gid) || low32(stat.size) !== BigInt(size)) {
        throw new Error(dirty);
      }
    } catch {
      throw new Error(dirty);
    }
  }
}

export function checkSourceGit(source: string, sha: string): void {
  requireSafeGitConfig(source);
  const root = git(source, ['rev-parse', '--show-toplevel'], 'source Git root');
  if (root !== `${source}\n`) throw new Error('Source path must resolve to the Git repository root.');

  const head = () => git(source, ['rev-parse', '--verify', 'HEAD^{commit}'], 'source HEAD').trim();
  if (head() !== sha) throw new Error('Source HEAD does not match the requested SHA.');

  const index = git(source, ['ls-files', '-v', '--stage', '--debug', '-z'], 'source Git index');
  checkTrackedFiles(source, index);
  const staged = git(source, ['diff-index', '--cached', '--name-only', '--no-renames', '--no-ext-diff',
    '--no-textconv', '--ignore-submodules=none', '-z', sha, '--'], 'staged source changes');
  const untracked = git(source, ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked source files');
  if (staged || untracked) throw new Error('Source working tree is dirty.');
  if (head() !== sha) throw new Error('Source HEAD changed during planning.');
}
