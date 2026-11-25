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

## Unified Allure 3 reports

Use the same explicit `--run-id <uuid>` selectors with `qe report plan`,
`qe report build`, and `qe report verify`. Order is irrelevant. The CLI accepts
1–32 distinct lowercase QEP UUIDv4s and uses only the runs named by those
selectors. The aggregate Allure export is limited to 10,000 cases and 2 MiB of
result JSON.

The `qep-audited-pass-v1` policy requires every run to pass 04.3 evidence
verification at its catalog repository and audited SHA. Each run must have a
PASS summary, child exit 0, COMPLETE collection, at least one passing case,
and zero failed, broken, or unknown cases. Skipped cases count toward the
total. The three catalog suites can be reported together. When the same
logical case appears in multiple selected runs, each execution counts
separately. Allure matches history using the stable, suite-scoped Contract v1
case ID. For repeated cases within one launch, QEP assigns additional
occurrence slots in sorted Run ID order to retain each execution. These
slots describe positions in the selection.

| Exit | Meaning |
| --- | --- |
| 0 | Eligible runs. JSON on stdout reports `planned`, `built`, `reused`, or `verified`. |
| 1 | A verified unsuccessful test execution makes the selection ineligible. |
| 2 | Invalid selectors, missing or invalid evidence, or a report build or verification error. |

Plan and verify are read-only. Build requires the local Allure 3.33.0 package
pinned by QEP and the Linux `/usr/bin/flock` utility. It generates in a private
staging directory and checks the output inventory, identities, statuses,
aggregate counts, and rendered history against the selected contracts and
accepted entries. It checks the selected evidence again before publication.
An existing destination is eligible for reuse only after read-only verification.
Open `.local/reports/<reportId>/index.html` to view the static report.

The report ID is the SHA-256 of the UTF-8 JSON serialization of
`["qep-report-v1", [[runId, manifestSha256], ...]]`, with pairs sorted by run ID.
The schema-v2 `report-manifest.json` records this ID, per-run verification
metadata, aggregate counts, the history sequence and predecessor report ID,
and the byte lengths and SHA-256 digests of `index.html`, `summary.json`,
`test-results.json`, and `history.jsonl`. Schema-v1 reports remain verifiable
and reusable with their original files. New reports start history independently
of those earlier reports.

### Local history and recovery

Each accepted build contributes exactly one Allure 3 JSONL entry, even when
it contains runs from all three suites. The entry lives at
`.local/reports/<reportId>/history.jsonl`. QEP holds an exclusive, nonblocking
lock on the private reports directory, checks the accepted sequence and
digests, then concatenates the entries into a staging file for Allure's
`historyPath`. Allure appends there, with no history limit configured. QEP
requires an unchanged prefix and one new entry that matches the report and
its verified cases. A single rename publishes the new line, report and
manifest together. Reusing or verifying an existing report adds zero entries.
[Allure 3 history format](https://allurereport.org/docs/how-it-works-history-files/)

`history.acceptedLaunches` describes the sequence at the report's publication.
The first report shows current status. Later reports show earlier results for
matching cases and may display coverage or success-rate comparisons. Allure's
line timestamp is the actual report generation time. Contract v1 supplies no
case timing fields, so QEP omits them and disables time-based charts. The
history retains the accepted PASS-policy data, which supports comparisons of
passing and skipped cases within the selected launches. Allure's single-file
viewer embeds up to six full prior launch entries. QEP retains every accepted
entry within its safety limits.

On a failed generation, QEP leaves accepted files intact and discards that
build's staging directory. A killed process or host stop can leave a private
`pending-*` directory. The kernel releases the writer lock on process exit,
and the next build ignores abandoned stages. Retry using the original Run IDs.
If the atomic publish already completed, the retry verifies and reuses it.
A missing or invalid accepted entry blocks builds until the owner restores
the affected files from a trusted private backup. Verification reads the
original run evidence and the history through the requested report. Detection
of a missing final report directory requires a trusted backup. This workflow
uses Linux procfs and trusts the QEP account, its local filesystem and the
installed generator.

Retain the complete report directories and their verified run evidence in
private storage. Review disk use periodically and before reaching the safety
limits of 512 accepted entries, 32 MiB of history, or 1,024 directory entries
in `.local/reports`. Make private, verified backups before any maintenance.
Changes to the accepted sequence or removal of historical reports require
explicit owner approval. QEP performs no automatic retention cleanup.
