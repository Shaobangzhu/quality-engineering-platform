import { git } from './source-git.js';

// Apply the policy to each component, including directories, before transfer.
const privateNames = [
  /^\.env(?:$|\.)|^\.envrc$/i,
  /(?:^|[._-])(?:credentials?|secrets?|passwords?|tokens?|(?:api|access|private)[-_]?keys?|service[-_]?accounts?|backups?)(?:$|[._-])/i,
  /^(?:\.git|\.aws|\.ssh|\.gnupg|\.docker|\.kube|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.my\.cnf|\.s3cfg|kubeconfig|\.gitcredentials|\.git-credentials|auth\.json|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i,
  /(?:\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|tfstate|bak\d*|bkp|backup|old|orig|save|sw[op])|~)$/i,
  /^(?:node_modules|site-packages|__pypackages__|bower_components|jspm_packages|web_modules|vendor|\.venv|venv|\.npm|\.pnpm-store|\.yarn)$/i,
];

type Entry = { mode: string; oid: string };

// Resolve one component at a time against the pinned tree. Normalizing ".."
// first would miss escapes through an intermediate directory symlink.
function checkLink(path: string, entries: Map<string, Entry>, targets: Map<string, string>): void {
  const directory = path.split('/');
  const pending = [directory.pop()!];
  let hops = 0;
  while (pending.length) {
    const part = pending.pop()!;
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (!directory.length) throw new Error('Tracked symlink escapes the workspace.');
      directory.pop();
      continue;
    }
    directory.push(part);
    const name = directory.join('/');
    const entry = entries.get(name);
    if (!entry) throw new Error('Tracked symlink points outside the committed tree.');
    if (entry.mode === '120000') {
      const target = targets.get(entry.oid)!;
      if (++hops > 40 || !target || target.startsWith('/') || /[\\\0]/.test(target)) {
        throw new Error('Unsafe tracked symlink target.');
      }
      directory.pop();
      pending.push(...target.split('/').reverse());
    } else if (pending.length && entry.mode !== '040000') {
      throw new Error('Tracked symlink traverses a non-directory.');
    }
  }
}

export function checkWorkspaceTree(source: string, sha: string): void {
  const tree = git(source, ['ls-tree', '-r', '-t', '-z', sha], 'committed source tree');
  const entries = new Map<string, Entry>();
  const links = new Map<string, string>();
  for (const line of tree.split('\0')) {
    if (!line) continue;
    const match = /^(040000|100644|100755|120000) (?:tree|blob) ([a-f0-9]{40})\t([^\0]+)$/.exec(line);
    if (!match) throw new Error('Unsupported entry in committed source tree.');
    const [, mode, oid, path] = match;
    const parts = path.split('/');
    if (parts.some((part, i) => {
      if (part === '.env.example' && i === parts.length - 1 && /^100/.test(mode)) return false;
      return !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part) ||
        privateNames.some((pattern) => pattern.test(part));
    })) throw new Error('Committed tree contains a private or unsupported path.');
    entries.set(path, { mode, oid });
    if (mode === '120000' && !links.has(oid)) {
      links.set(oid, git(source, ['cat-file', 'blob', oid], 'committed symlink target'));
    }
  }
  if (!entries.get('package.json')?.mode.startsWith('100')) {
    throw new Error('The commit must contain a regular package.json.');
  }
  for (const [path, entry] of entries) {
    if (entry.mode === '120000') checkLink(path, entries, links);
  }
}
