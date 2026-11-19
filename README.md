# Quality Engineering Platform

QEP is a platform for federated test orchestration, cross-repository consumer testing, centralized Allure 3 reporting, and CI/CD quality gates.

INFRA-04.2.1 provides the Node.js and TypeScript CLI foundation. INFRA-04.2.2 adds a suite catalog and read-only planning. INFRA-04.2.3 provisions isolated, SHA-pinned source workspaces.

## Development

Use Node.js 22.23.4 from `.nvmrc` and npm 10.9.0 or newer.

```sh
nvm install
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run qe -- help
npm run qe -- --version
```

## Plan a suite

Build QEP first. Use the built `qe` executable on your PATH or invoke it with `node dist/cli.js`.

```sh
qe plan --suite dgi-backend-unit --source "$SOURCE_PATH" --sha "$SOURCE_SHA"
qe plan --suite clu-unit --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
```

Supply an absolute source checkout path and its full, 40-character Git HEAD SHA.

| Suite | Source `package.json` name | Planned command |
| --- | --- | --- |
| `dgi-backend-unit` | `delivery-geo-intelligence` | `npm run test:backend:unit` |
| `dgi-frontend-unit` | `delivery-geo-intelligence` | `npm run test:frontend` |
| `clu-unit` | `@shaobangzhu/clu-ui` | `npm test` |

The plan identifies an isolated workspace and an artifact destination under the QEP root. Both paths contain a `<run-id>` placeholder for a future run. All three profiles declare zero database and Docker requirements. Planning prints these details and checks the source using Git and package metadata. The JSON command object has separate `executable` and `args` fields. Invalid input produces a diagnostic on stderr and exits with code 2.

Planning supports local SHA-1 Git checkouts with a `.git` directory, a regular source `package.json`, and a Git executable that supports `--no-lazy-fetch`. It rejects linked and sparse worktrees, submodules, and Git configuration includes. An ordinary Git checkout with stale index timestamps can be rejected even when the tracked bytes match. The planner checks the installed npm package metadata through the standard `bin/npm-cli.js` launcher and validates Node and npm against QEP's requirements and any corresponding source `engines` ranges.

## Provision a workspace

Choose an approved local checkout and an independently approved full commit SHA. Use its canonical absolute path with a suite from the catalog.

```sh
qe workspace --suite clu-unit --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
```

QEP checks the source HEAD, clean index and working tree, package identity, suite script, and runtime requirements. It inspects the pinned Git tree for secret-like names, credential files, backups and dependency directories. A regular `.env.example` is the dotenv documentation exception. Relative tracked symlinks must resolve entirely within the committed tree, including through other links. Ignored source files stay in the original checkout.

Each successful invocation returns a cryptographically generated run ID, the run and workspace paths, the suite ID and the canonical source provenance. Run storage is relative to the installed QEP root, independent of the caller's working directory.

```text
.local/runs/<runId>/
└── workspace/
```

QEP rejects path traversal, symlinked directory components, overlapping source and run storage, and shared write access to the storage directories. Exclusive creation of a private run directory prevents a collision from reusing an earlier run. After reservation, a failure reports the run ID and leaves the directory for inspection. A future phase can write `summary.json` alongside `workspace/`.

Provisioning requires Git with `clone --revision` support. A depth-one local Git transfer requests the exact commit, disables hardlinks and tags, and permits only file transport. QEP disables hooks and clone templates, checks out the SHA detached inside the new clone, verifies its HEAD and package identity, and removes its source remote. It rechecks the source HEAD, branch reference and clean state before reporting success. Supported source repositories use self-contained Git storage and ordinary local configuration. Includes, external object stores, split indexes, shallow sources, symlinked Git metadata and unrecognized local configuration are rejected.

### Trust boundary

Workspace isolation protects source files and run evidence from ordinary edits in the disposable checkout. It provides no OS sandbox. Code executed later would retain the host user's filesystem, network and service permissions. Restrict future execution to audited suites and approved commits. Path checks identify conventional private filenames. Reviewing committed content, including example configuration, remains part of approving the SHA. Provisioning assumes trusted local executables and stable source and storage directories under the operator's control.
