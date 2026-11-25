# Runbook

## Validate QEP on Ubuntu

In a normal Ubuntu Remote-SSH terminal, use Git with `clone --revision` support and run:

```sh
cd /home/clu/projects/quality-engineering-platform
nvm install
nvm use
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run lint
npm test
git diff --check
```

The Codex sandbox can deny Git subprocess creation in Node fixtures with `spawnSync git EPERM`. A successful standard test run in a normal Ubuntu terminal or GitHub Actions can verify the supported-environment test gate. Hosted QEP CI must pass before merge.

## Plan, provision and execute

Use a local, ordinary SHA-1 Git checkout with an absolute canonical path and a clean index and working tree. Validate the source identity and HEAD against the independently approved baseline. Stop if either differs. Git must also support `--no-lazy-fetch`. Stale index stat metadata can trigger a rejection even when Git reports a clean tree.

Set `SUITE` to a catalog ID, `SOURCE_PATH` to the approved checkout's absolute path and `SOURCE_SHA` to its full 40-character SHA.

The November 24, 2026 acceptance covered these three reviewed profiles at the pinned revisions below. The accepted QEP implementation baseline, `e769d14dc3374c6c6eabd951a480a593bca3856c`, still applies after any future documentation-only merge. See the [final acceptance evidence](acceptance-04.2.md#final-level-a-and-level-b-acceptance--2026-11-24).

| Suite ID | Catalog command | Source and revision | Evidence format |
| --- | --- | --- | --- |
| `dgi-backend-unit` | `npm run test:backend:unit` | `delivery-geo-intelligence` (`main`), `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | `node-spec` |
| `dgi-frontend-unit` | `npm run test:frontend` | `delivery-geo-intelligence` (`main`), `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | `dgi-frontend-allure` |
| `clu-unit` | `npm test` | `react-clu-component-lib` (`master`, `@shaobangzhu/clu-ui`), `84c2b3435b63e6290e6bc60578d6a6dc6665e465` | `standard` |

For new CLU runs, use the 04.3.3 merge SHA in the collection instructions below. Use the following templates for future authorized runs. Run one suite at a time. The approved profiles require neither Docker nor a database.

```sh
node dist/cli.js plan --suite "$SUITE" --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
```

`plan` and `run` without `--execute` are read-only. They show the fixed command and intended paths without provisioning a workspace, installing dependencies, or running source tests.

```sh
node dist/cli.js workspace --suite "$SUITE" --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
```

`workspace` is optional and provisions a detached checkout for inspection. Each explicit `run --execute` creates its own isolated workspace, even if you previously provisioned a separate workspace.

```sh
node dist/cli.js run --suite "$SUITE" --source "$SOURCE_PATH" --sha "$SOURCE_SHA" \
  --execute --install-deps --json
```

Use the optional `--install-deps` only for an approved install profile. All three profiles above require dependency installation. With this flag, QEP runs `npm ci --ignore-scripts --include=dev` inside the isolated run workspace using the approved committed registry lockfile. Omit the flag for a dependency-free direct Node suite. The install and test phases each default to a 300,000 ms timeout. Override with `--timeout-ms` from 1 to 1,800,000.

Use only owned, reviewed workloads at approved revisions. Workspace isolation provides filesystem separation for ordinary writes and has limits at the OS level. Git status and index checksums cover tracked Git state, with no guarantee for every ignored file. Structural dependency checks verify the installed layout and metadata, with package-archive attestation outside their scope. [Security boundaries](security-boundaries.md)

If QEP blocks an attempt, record the phase and reason and stop that attempt. Keep the approved command, checkout policy and install restrictions in effect. A failure before reservation has no workspace, run ID or summary.

## Read results and recover

Read `.local/runs/<runId>/summary.json` for a reserved execution. With `--json`, QEP also prints the summary on stdout for success and stderr for other terminal states. Summary v0 stores the child exit code. Record the QEP CLI exit status separately. A null child exit code can mean no child started or a signal ended it. A passing run requires child exit 0 and recognized positive evidence. Negative evidence on either stream overrides positive evidence, and missing required positive evidence is a failure. Ordinary child failures propagate their nonzero code. Timeout exits 124, SIGINT cancellation exits 130 and SIGTERM cancellation exits 143.

| Evidence format | Interpretation |
| --- | --- |
| `standard` | Recognizes supported TAP or Jest/Vitest summaries. Bounded ANSI SGR normalization supports reset and decimal SGR parameters within a 4,096-character raw-line limit. Unsupported controls or ambiguous overlong evidence can veto a pass. Explicit failed `Test Files` evidence vetoes a pass even when collected tests pass. |
| `node-spec` | Requires the reviewed Node spec count block and duration line, consistent totals, a positive pass count, and zero failures and cancellations. |
| `dgi-frontend-allure` | Requires one valid raw audited `frontend/unit` footer on stdout with a positive pass count. Duplicate or malformed footers, conflicting console counts, nonzero failure or skip counts, and negative evidence on stderr veto a pass. |

When an execution appears stuck, send SIGINT or SIGTERM to QEP and allow its cleanup to finish. The execution lock covers the entire run, including dependency installation and test execution.

If `.local/runs/execution.lock` remains, do not assume that it is stale. Before considering manual removal, verify that the prior QEP process and all subprocesses and descendants associated with that execution have stopped, including dependency installation and test processes. If process termination or cleanup cannot be verified, leave the lock in place and investigate further.

**Never remove an active execution lock or bypass the exclusive execution policy.** Retain sanitized evidence for review. Workspaces and local summaries are Git-ignored.

## Available artifacts and deferred capabilities

Summary v0 remains unchanged. QEP leaves the run workspace available for inspection and retains no raw child stdout or stderr. The exact historical CLU console stream is unavailable. Synthetic regressions independently reproduced the ANSI defects, and the historical stream cannot be reconstructed from those fixtures.

## Verify a completed DGI unit run

Supply the QEP UUID printed by the runner. The adapter uses the installed QEP run directory on Linux.

```sh
node dist/cli.js adapt-dgi --run-id "$QEP_RUN_ID"
```

Exit 0 means verification succeeded. Read `executionStatus` and `childExitCode` in the returned JSON for the suite outcome. Exit 2 means the adapter could not verify the evidence. It emits a diagnostic on stderr and leaves stdout empty. The command reads the selected workspace and writes the contract to stdout. Repeating it preserves the run artifacts. [DGI adapter implementation report](infra-04.3.2-dgi-allure-adapter.md)

## Collect and verify unit results

CLU reporting requires the reviewed INFRA-04.3.3 merge, `8bda12f627e6234ed122fef29b48bd5ee2e2706d` (CLU PR #17). For a fresh acceptance run, use a clean CLU checkout at this exact revision.

```sh
qe run --suite clu-unit --source "$CLU_CHECKOUT" --sha 8bda12f627e6234ed122fef29b48bd5ee2e2706d \
  --execute --install-deps --clu-junit --json
qe results collect --run-id "$QEP_RUN_ID"
qe results verify --run-id "$QEP_RUN_ID"
```

Set `QEP_RUN_ID` to the UUID from the new summary. The runner sets `QEP_REPORTING=1` for the reviewed `npm test` child when `--clu-junit` is present. It reserves a fresh report directory and records SHA-256 digests of Summary v0 and the bounded XML in a private run receipt. Collection reconciles the receipt, summary identity, execution outcome, suite totals and individual cases. The receipt relies on the existing trust in the local QEP account.

Both results commands accept one lowercase QEP UUIDv4. They also support the reviewed DGI unit suites through the existing audited adapter. Collection publishes `result-v1.json` and `manifest-v1.json` together under `.local/runs/<uuid>/results-v1/`. Verification reads the original evidence and checks both files against a fresh normalization. An identical collection retry preserves the existing files. Missing, partial or conflicting evidence exits 2 with a diagnostic on stderr. Success prints the verified manifest and exits 0, including for a verified unsuccessful execution.

For real-source acceptance, record the new run UUID, QEP and child exit codes, summary status, normalized counts and manifest digest. Confirm a collection retry preserves the artifact bytes, verify again, and check the source checkout and index against their pre-run state. Retain the normalized artifacts within QEP run storage.
