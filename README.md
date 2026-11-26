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
| `qe candidate build`, `qe candidate verify`, `qe candidate inject` | Build and verify a private CLU tarball, then prepare or install it in an isolated DGI consumer. |
| `qe adapt-dgi --run-id <uuid>` | Verify a completed DGI unit run and print Contract v1 JSON. |
| `qe results collect --run-id <uuid>` | Normalize verified DGI or CLU evidence and publish the Contract v1 result and manifest. |
| `qe results verify --run-id <uuid>` | Check the saved pair against the run's original evidence. |
| `qe report plan --run-id <uuid> ...` | Reverify explicitly selected runs and show the intended local report ID and counts. |
| `qe report build --run-id <uuid> ...` | Generate a private static Allure 3 report or reuse verified output for the same selection. |
| `qe report verify --run-id <uuid> ...` | Reconcile the saved report, manifest and history with the selected runs. |

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

QEP CI runs build, typecheck, lint, Contract v1 and adapter fixtures, the standard tests including Allure export, assembly and history, and a standalone Allure generator fixture. It uses the QEP checkout and synthetic data. [Runbook](docs/runbook.md) · [QEP CI](.github/workflows/ci.yml)

## CLU candidate artifacts

After reviewing the exact CLU commit and its build and test inputs, explicitly select its clean checkout and full HEAD SHA. The current CLU master SHA is a baseline until selected through this command. Run from a QEP development install on Linux.

```sh
node dist/cli.js candidate build --source "$CLU_SOURCE" --sha "$CLU_SHA"
node dist/cli.js candidate verify --sha "$CLU_SHA"
```

The build checks the approved Git origin and package identity, provisions a detached checkout under `.local/consumer-gate/<sha>/`, and runs the lockfile install with lifecycle hooks disabled. It explicitly runs `vite build && node scripts/build-types.mjs` and `vitest run` through the approved npm scripts. A passing unit suite with positive test evidence is required before packing with `npm pack --ignore-scripts`. Only the candidate tarball and receipt are retained after a successful build.

Both commands print the paths to `candidate.tgz` and `receipt.json`. The receipt records the producer SHA, package name and version, exact npm version, reviewed commands, byte size, SHA-256 and SHA-512 SRI. Verification reads the existing archive, checks it against the receipt, and validates the package contract and member inventory. A second build for that SHA fails, including when the existing reservation is incomplete or the retained bytes fail verification.

Archive checks cover the ESM and declaration entries, the CSS export, the reachable declaration graph, regular-file tar members, the React peer and external imports, common React bundle markers, and credential-like content.

The origin check verifies local Git configuration. Review of the selected commit establishes trust in the build and test code, and the private checkout isolates ordinary writes. [Security boundaries](docs/security-boundaries.md)

### Isolated DGI consumer

Use the full SHA of the reviewed DGI checkout, the full CLU producer SHA, and the independently approved SHA-512 SRI from the candidate receipt. The DGI source must be clean at the selected SHA and have the approved DGI GitHub origin configured locally.

```bash
node dist/cli.js candidate inject --source "$DGI_SOURCE" --sha "$DGI_SHA" \
  --candidate-sha "$CLU_SHA" --integrity "$CLU_INTEGRITY"
```

Each invocation creates separate detached `baseline` and `candidate` checkouts under `.local/consumer-gate/<run-id>/`. The baseline retains the published CLU resolution. The candidate stores the verified tarball at its checkout root, changes the CLU dependency in `frontend/package.json`, and changes its matching dependency spec and package record in the **root** `package-lock.json`. It checks the exact allowed delta against the baseline.

Add `--install-deps` with separate approval to run `npm ci --ignore-scripts --include=dev` in the candidate checkout. npm uses a per-run cache and may fetch the baseline-pinned registry dependencies. The command checks the installed npm lock entry, matches installed CLU bytes against the archive, resolves the JavaScript, declarations and CSS, and verifies one compatible React installation. Preparation alone reports `prepared`. A verified install reports `installed-and-verified`. DGI builds, tests and application runtime behavior are outside this command.

## Local Allure 3 reporting

Select the UUIDs of runs with already collected Contract v1 pairs. Use the same
selectors for planning, building and verification.

```sh
node dist/cli.js report plan --run-id "$RUN_A" --run-id "$RUN_B"
node dist/cli.js report build --run-id "$RUN_A" --run-id "$RUN_B"
node dist/cli.js report verify --run-id "$RUN_A" --run-id "$RUN_B"
```

The build prints the private report directory. Open its `index.html` locally.
Each newly built report adds one Allure 3 history entry. Repeating the same
selection verifies and reuses the report. Plan and verify are read-only.
[Allure 3 architecture](docs/allure3-architecture.md) · [Allure 3 runbook](docs/allure3-runbook.md)

## Static site promotion

Use `qe site plan`, `qe site promote --publish` and `qe site verify` with the
same explicit Run IDs as the accepted local report. The owner provisions
`/home/clu/infra/qep-report-site`. Promotion copies only the verified HTML,
preserves prior releases and switches the relative `current` symlink atomically.
[Site promotion runbook](docs/allure3-runbook.md#0451-static-site-promotion)

Use the dedicated `qep-report-hosting` Nginx project to serve the promoted
report at `http://127.0.0.1:7300/`. [Hosting acceptance and rollback](docs/hosting-04.5-runbook.md)

## Test safety

QEP uses local, disposable Git checkouts and a sanitized child environment. The install path uses a committed registry lockfile with lifecycle hooks disabled. The runner permits supported unit-test commands and blocks unsupported profiles and install layouts. A disposable checkout provides filesystem separation for ordinary test writes. It does **not** provide OS-level isolation. Execute only owned, audited repositories at approved revisions. [Security boundaries](docs/security-boundaries.md)

## Roadmap

**INFRA-04.3 — Test Result Standardization & Adapters: Closed — PASS.** Three fresh Ubuntu unit suites passed 529/529 tests. Contract v1 artifacts, provenance and integrity checks passed final acceptance. [Final acceptance](docs/acceptance-04.3.md#infra-043--final-acceptance-closure) · [Contract v1](docs/result-contract-v1.md) · [Adapters](docs/adapters.md)

**INFRA-04.4 — Centralized Allure 3 reporting: Closed — PASS.** Independent Ubuntu review verified all 529 rendered cases, report integrity and reuse, and Chromium smoke checks. [Final acceptance](docs/acceptance-04.4.md#infra-044--closed--pass)

**INFRA-04.5 — Allure report hosting — PASS / CLOSED.** Ubuntu verified loopback-only hosting and database continuity during the controlled Nginx restart. The Mac operator saw 529/529 passed through the Remote-SSH forward and confirmed the downloaded HTML matched the approved digest. [Final acceptance](docs/acceptance-04.5.md)

Future work includes cross-repository consumer testing and INFRA-04.8 branch protection.
