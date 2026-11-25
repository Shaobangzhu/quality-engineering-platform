# Quality Engineering Platform

QEP v0.1 is a personal Quality Engineering MVP built in TypeScript. It uses a typed CLI and a fixed suite catalog to tie unit checks to reviewed Git revisions. Read-only planning, SHA-pinned workspaces and controlled execution make checks reproducible while keeping installs and tests inside disposable snapshots.

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

## INFRA-04.2 acceptance

INFRA-04.2 — Repository Foundation & TypeScript Test Orchestrator is technically complete. The project owner accepted Level A — Pragmatic MVP and Level B — Original Full Scope on November 24, 2026.

- 118/118 QEP standard tests passed in ordinary Ubuntu and hosted QEP CI.
- 3/3 reviewed real-source suites passed at their pinned revisions (`dgi-backend-unit`, `dgi-frontend-unit` and `clu-unit`).
- The independent audit cross-checked 257/257 passing DGI frontend tests and verified 14/14 historical summary checksums.

The accepted QEP implementation baseline, `e769d14dc3374c6c6eabd951a480a593bca3856c`, still applies after any future documentation-only merge. See the [final acceptance report](docs/acceptance-04.2.md#final-level-a-and-level-b-acceptance--2026-11-24) for evidence and scope limits.

## What works today

| Command | Behavior |
| --- | --- |
| `qe help`, `qe --version` | Show usage or version. |
| `qe plan` | Validate the source and show the catalog command and intended run paths. |
| `qe workspace` | Provision a unique detached checkout at the requested SHA. |
| `qe run` | Plan by default. With `--execute`, run one supported unit script at a time with process cleanup, timeout and cancellation. |
| `qe adapt-dgi --run-id <uuid>` | Verify a completed DGI unit run and print Contract v1 JSON. |
| `qe results collect --run-id <uuid>` | Normalize verified DGI or CLU evidence and publish the Contract v1 result and manifest. |
| `qe results verify --run-id <uuid>` | Check the saved pair against the run's original evidence. |

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

The runbook covers provisioning, execution commands and how to interpret blocked runs. QEP CI runs build, typecheck, lint, synthetic contract and adapter fixtures, and the standard tests for main pushes and pull requests targeting main. [Runbook](docs/runbook.md) · [QEP CI](.github/workflows/ci.yml)

For a local Allure 3 report, select the UUIDs of runs with already collected
Contract v1 pairs. Use the same selectors for planning, building and verification.

```sh
node dist/cli.js report plan --run-id "$RUN_A" --run-id "$RUN_B"
node dist/cli.js report build --run-id "$RUN_A" --run-id "$RUN_B"
node dist/cli.js report verify --run-id "$RUN_A" --run-id "$RUN_B"
```

The build prints the private report directory. Open its `index.html` locally.
Each newly accepted report adds one local Allure 3 history entry. Repeating
the same selection reuses the report, and verification is read-only.
[Report policy and local history](docs/runbook.md#unified-allure-3-reports)

## Test safety

QEP uses local, disposable Git checkouts and a sanitized child environment. The install path uses a committed registry lockfile with lifecycle hooks disabled. The runner permits supported unit-test commands and blocks unsupported profiles and install layouts. A disposable checkout provides filesystem separation for ordinary test writes. It does **not** provide OS-level isolation. Execute only owned, audited repositories at approved revisions. [Security boundaries](docs/security-boundaries.md)

## Roadmap

**INFRA-04.3 — Test Result Standardization & Adapters: Closed — PASS.** Three fresh Ubuntu unit suites passed 529/529 tests. Contract v1 artifacts, provenance and integrity checks passed final acceptance. [Final acceptance](docs/acceptance-04.3.md#infra-043--final-acceptance-closure) · [Contract v1](docs/result-contract-v1.md) · [Adapters](docs/adapters.md)

Future work includes Nginx report hosting, cross-repository consumer and candidate testing, and INFRA-04.8 branch protection.
