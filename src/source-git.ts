import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const gitEnvironment = {
  PATH: (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute).join(delimiter),
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_ALLOW_PROTOCOL: '',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd: string, args: readonly string[], label: string, localClone = false): string {
  try {
    const output = execFileSync('git', [
      '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects',
      '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0',
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null',
      '-C', cwd, ...args,
    ], {
      cwd: '/',
      env: localClone ? { ...gitEnvironment, GIT_ALLOW_PROTOCOL: 'file' } : gitEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    throw new Error(`Cannot check ${label} using Git.`);
  }
}

// upload-pack reads the source's local configuration and object database. Only
// use self-contained repositories with ordinary storage and inert local settings.
function checkCloneMetadata(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Git can freshen a shared index's mtime even during a read operation.
    if (entry.name.startsWith('sharedindex.')) throw new Error('Split Git indexes are unsupported.');
    if (entry.isDirectory()) checkCloneMetadata(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error('Source has unsupported Git metadata.');
  }
}

function requireSafeGitConfig(source: string, forClone: boolean): void {
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

  if (forClone) {
    checkCloneMetadata(gitDirectory);
    for (const name of ['shallow', 'info/grafts', 'objects/info/http-alternates']) {
      if (lstatSync(join(gitDirectory, name), { throwIfNoEntry: false })) {
        throw new Error('Source has unsupported Git metadata.');
      }
    }
  }

  // Parse only the local config, with discovery and includes disabled.
  const keys = git('/', ['config', '--file', config, '--no-includes', '--name-only', '--null', '--list'], 'source Git configuration');
  if (keys.split('\0').some((key) =>
    /^(?:include\.|includeif\.|core\.worktree$|extensions\.worktreeconfig$)/i.test(key))) {
    throw new Error('Source Git configuration uses includes or a separate worktree.');
  }
  if (forClone) {
    const allowed = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|autocrlf|symlinks|fsmonitor)|user\.(?:name|email)|remote\..+\.(?:url|pushurl|fetch)|branch\..+\.(?:remote|merge|pushremote|vscode-merge-base))$/i;
    if (keys.split('\0').some((key) => key && !allowed.test(key))) {
      throw new Error('Source has unsupported local Git configuration for cloning.');
    }
  }
}

// Git reports the stat fields it cached in the index. A change to those fields
// is enough to reject the checkout without opening tracked files to hash them.
const indexEntry = /([^ ]) (100644|100755|120000|160000) [0-9a-f]{40} ([0-3])\t([^\0]+)\0  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: [0-9a-f]+\n/y;

function checkTrackedFiles(source: string, index: string): void {
  const dirty = 'Source working tree is dirty or its tracked-file metadata has changed.';
  const directories = new Set<string>();
  for (let offset = 0; offset < index.length; offset = indexEntry.lastIndex) {
    indexEntry.lastIndex = offset;
    const entry = indexEntry.exec(index);
    if (!entry) throw new Error('Cannot inspect source Git index metadata.');
    const [, tag, mode, stage, file, ctimeSec, ctimeNs, mtimeSec, mtimeNs, dev, ino, uid, gid, size] = entry;
    if (tag !== 'H' || mode === '160000' || stage !== '0') {
      throw new Error('Source Git index contains submodules, conflicts, or hidden working-tree changes.');
    }

    const path = join(source, file);
    try {
      const parts = file.split('/');
      if (parts.some((part) => part === '..' || part === '.' || !part)) throw new Error(dirty);
      let parent = source;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        if (directories.has(parent)) continue;
        if (!lstatSync(parent).isDirectory()) throw new Error(dirty);
        directories.add(parent);
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

export function checkSourceGit(source: string, sha: string, forClone = false, workspaceDeps?: boolean): void {
  requireSafeGitConfig(source, forClone);
  const root = git(source, ['rev-parse', '--show-toplevel'], 'source Git root');
  if (root !== `${source}\n`) throw new Error('Source path must resolve to the Git repository root.');

  const head = () => git(source, ['rev-parse', '--verify', 'HEAD^{commit}'], 'source HEAD').trim();
  if (head() !== sha) throw new Error('Source HEAD does not match the requested SHA.');

  const index = git(source, ['ls-files', '-v', '--stage', '--debug', '-z'], 'source Git index');
  checkTrackedFiles(source, index);
  const staged = git(source, ['diff-index', '--cached', '--name-only', '--no-renames', '--no-ext-diff',
    '--no-textconv', '--ignore-submodules=none', '-z', sha, '--'], 'staged source changes');
  // A disposable checkout may contain only the dependencies from this run's install,
  // including when the commit ignores additional files such as dotenv configuration.
  const exclusions = workspaceDeps === undefined ? ['--exclude-standard'] :
    workspaceDeps ? ['--directory', '--exclude=/node_modules/'] : ['--directory'];
  const untracked = git(source, ['ls-files', '--others', '-z', ...exclusions], 'untracked source files');
  if (staged || untracked) throw new Error('Source working tree is dirty.');
  if (head() !== sha) throw new Error('Source HEAD changed during validation.');
}
