# Quality Engineering Platform

QEP v0.1 is a personal Quality Engineering MVP built in TypeScript. It uses a typed CLI and a fixed suite catalog to tie unit checks to reviewed Git revisions. Read-only planning, SHA-pinned workspaces and controlled execution make checks reproducible while keeping installs and tests inside disposable snapshots.

The catalog includes `dgi-backend-unit`, `dgi-frontend-unit` and `clu-unit`. Each is an implemented catalog entry. Real-source integration is experimental and remains unverified for all three. Real smoke runs are deferred for MVP acceptance. [Acceptance report](docs/acceptance-04.2.md)

```text
Approved checkout + full Git SHA + catalog suite
       │
       ▼
Validate source and print a read-only plan
       │
       ├── qe workspace ──► provision a detached checkout
       │
       └── qe run --execute
              │
              ▼
       Reserve exclusive execution and provision a fresh checkout
              │
              ▼
       Check command and install policy, then run the unit suite
              │
              ▼
       Write a minimal local summary for the reserved run
```

## What works today

| Command | Behavior |
| --- | --- |
| `qe help`, `qe --version` | Show usage or version. |
| `qe plan` | Validate the source and show the catalog command and intended run paths. |
| `qe workspace` | Provision a unique detached checkout at the requested SHA. |
| `qe run` | Plan by default. With `--execute`, run one supported unit script at a time with process cleanup, timeout and cancellation. |

A reserved execution writes Run Summary v0 to `.local/runs/<runId>/summary.json` with the suite, SHA, timing, status and child exit code. A passing test run requires exit 0 and positive evidence from a supported reporter. See the [architecture](docs/architecture.md) for the suite catalog and result flow.

## Run QEP locally

Use Node.js 22.23.4 from `.nvmrc` and npm 10.9.0 or later. For workspace creation and execution, use Linux with procfs for the runner and a Git version that supports `clone --revision`.

```sh
nvm install
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run lint
npm test
git diff --check
node dist/cli.js help
```

Supply a reviewed checkout path and full SHA. Planning leaves the source and run storage untouched.

```sh
node dist/cli.js plan --suite clu-unit --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
```

The [runbook](docs/runbook.md) covers provisioning, execution commands and how to interpret blocked runs. The [QEP CI workflow](.github/workflows/ci.yml) defines the same build, typecheck, lint and unit test steps for main pushes and pull requests targeting main.

## Test safety

QEP uses local, disposable Git checkouts and a sanitized child environment. The install path uses a committed registry lockfile with lifecycle hooks disabled. The runner permits supported unit-test commands and blocks unsupported profiles and install layouts. A disposable checkout provides filesystem separation for ordinary test writes. It does **not** provide OS-level isolation. Execute only owned, audited repositories at approved revisions. [Security boundaries](docs/security-boundaries.md)

## Roadmap

INFRA-04.2 introduced the CLI, catalog, planner, isolated workspaces and controlled execution. INFRA-04.2.5 adds the QEP-only workflow definition and documents the real source smoke attempts. INFRA-04.3 is the planned Result Contract. Allure 3 reporting and cross-repository candidate testing are planned capabilities. Branch protection belongs to INFRA-04.8.
