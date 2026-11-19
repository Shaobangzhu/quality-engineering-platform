# INFRA-04.2 Implementation Acceptance Report

Acceptance attempt on 2026-11-19 UTC. QEP started clean on `test/infra-04.2.5-acceptance` at `0acbb53`, the 04.2.4 merge on the local `origin/main` reference. DGI and CLU started clean and matched the full INFRA-04.1 SHAs below. Local runtime was Node.js 22.23.4, npm 10.9.9 and Git 2.53.0.

## A. Implemented features

The merged TypeScript CLI provides a fixed unit suite catalog, read-only planning, SHA-pinned Git snapshots, controlled npm execution, per-installation locking, process-group cleanup and minimal local v0 summaries. INFRA-04.2.5 adds a QEP-only CI workflow definition and documents the acceptance checks and blockers.

## B. Platform test results

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run build` | PASS | Exit 0 |
| `npm run typecheck` | PASS | Exit 0 |
| `npm run lint` | PASS | Exit 0 |
| `npm test` | FAIL | Exit 1. Plan, workspace and runner test files failed in the restricted session. Direct diagnosis reproduced `spawnSync git EPERM` in fixture setup. |
| `git diff --check` | PASS | Exit 0 |

Supplemental validation ran directly through the built CLI and through real npm with disposable synthetic platform fixtures. All four CLI help and argument tests passed in a direct invocation of `test/cli.test.js`.

| Behavior | Observed evidence |
| --- | --- |
| Read-only planning and source validation | All three real `plan` and default `run` outputs matched. Wrong SHAs and package identities were rejected. Source indexes and the run directory listing remained unchanged. |
| Isolated workspaces and strict command allowlisting | Two DGI snapshots had different run IDs, verified detached HEADs, matching package identities, clean trees and empty remote lists. The runner stopped both on their unsupported commands. |
| Nonzero propagation and evidence enforcement | A real npm fixture propagated child exit 23. A fixture exiting 0 without test evidence produced `FAIL` and CLI exit 1. QEP also accepted genuine Node TAP evidence from a platform fixture that asserted the sanitized child environment. |
| Timeout, cancellation and exclusive execution | A real npm fixture forwarded timeout SIGTERM and returned 124. Live runs rejected a concurrent execution with 2. SIGINT and SIGTERM cancellation returned 130 and 143. Process cleanup and lock release were verified. |
| Sanitized summaries | Fixture summaries matched on disk and in CLI JSON, contained only v0 fields and omitted the emitted synthetic output marker. The DGI summaries recorded their phase, category, and null child exits. |

## C. DGI / CLU smoke results

The three approved suites were attempted sequentially using `qe run --execute --install-deps --json`. Both DGI scripts dispatch through npm workspaces (`npm run test:unit -w backend` and `npm test -w frontend`). The merged runner allows direct unit commands and rejected both scripts with `unsupported-profile`. CLU was rejected before reservation because its committed tree contains names excluded by policy, including `.npmrc`. The file contents were left unread. All attempts ended before install and test process launch.

## D. Per-run provenance and status

| Suite | Approved source SHA | Run ID | Child exit | CLI exit | Status | Duration | Expected test evidence |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| `dgi-backend-unit` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | `af19df60-de21-4bcc-b137-13cfeed85d9f` | null | 2 | BLOCKED | 247 ms | Absent |
| `dgi-frontend-unit` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | `c4392f33-1bd4-416b-bc56-64b3fb2dfcb6` | null | 2 | BLOCKED | 258 ms | Absent |
| `clu-unit` | `84c2b3435b63e6290e6bc60578d6a6dc6665e465` | Unassigned | Unavailable | 2 | BLOCKED | 108 ms wall clock | Absent |

The DGI durations come from `.local/runs/<runId>/summary.json`. CLU has no summary because the committed-tree check precedes reservation.

## E. GitHub Actions workflow status and limitations

The [workflow](../.github/workflows/ci.yml) defines one Ubuntu job for pushes to main and pull requests targeting main. It uses Node.js 22.23.4 via `.nvmrc`, read-only contents permissions, non-persisted checkout credentials and `npm ci --ignore-scripts` from QEP's lockfile. Its checks are build, typecheck, lint and unit tests. It uses QEP sources and QEP unit fixtures. The YAML, triggers, permissions and command sequence were checked locally. Hosted execution remains pending. Branch protection is deferred to INFRA-04.8.

## F. Safety compliance

DGI and CLU retained their approved HEADs, clean Git status and the same index content through the smoke attempts. Both reserved workspaces and summaries are Git-ignored. The remaining QEP changes are the intended workflow and documentation.

The source attempts stayed within the existing Git and workspace policy. A platform fixture verified the runner's sanitized npm child environment. No dependency install, lifecycle hook, Docker command, database operation, dotenv or secret read, browser test, integration test or E2E test occurred in the source attempts. Docker containers, databases and existing secrets were untouched by this work. Execution checks wrote only to QEP run storage and temporary platform fixtures. The disposable checkout separates ordinary writes. Suite code runs with the effective OS permissions.

## G. Known limitations and deferred milestones

The restricted policy excludes DGI's workspace dispatch and CLU's committed path layout. Install compatibility for all three suites remains unverified. Any future support requires review of the exact commands, committed paths and lockfile lifecycle requirements. The local test environment also blocks fixture setup used by the standard QEP test command. INFRA-04.3 Result Contract, Allure 3 reporting, cross-repository candidate testing and INFRA-04.8 branch protection remain future work.

## H. Acceptance matrix

| Criterion | Status |
| --- | --- |
| Acceptance branch, merged runner and exact clean source baselines | PASS |
| QEP build, typecheck, lint and diff check | PASS |
| QEP standard platform unit suite in this session | FAIL |
| Requested runner behaviors via supplemental CLI checks | PASS |
| DGI backend smoke with real test evidence | BLOCKED |
| DGI frontend smoke with real test evidence | BLOCKED |
| CLU smoke with real test evidence | BLOCKED |
| Minimal QEP CI workflow definition and acceptance documentation | PASS |
| Hosted QEP CI result | BLOCKED |
| Source preservation and safety constraints | PASS |

## I. GO / NO-GO recommendation

**NO-GO for formal INFRA-04.2 acceptance.** A successful standard platform test run and genuine unit evidence from all three pinned source suites are outstanding. Resolve source compatibility through a reviewed approach that preserves the restrictions, then repeat the smoke attempts sequentially. Confirm the hosted QEP workflow in the normal review process.

## INFRA-04.2.5 remediation

### A. Preflight

The remediation started on `test/infra-04.2.5-acceptance` at `0acbb5301f04842df9395157e4b9392feb9ae0de` with the pending CI, README and four documentation files from the original attempt. Both source repositories were clean and at the approved full SHAs recorded above.

### B. Root causes

| Suite | Verified finding |
| --- | --- |
| CLU | The private-path scan rejected the root `.npmrc` and three design-token files. The npm v3 lock also contains published ESLint workspace metadata, bundled Tailwind WASI dependencies and install-script markers for esbuild and macOS fsevents. |
| DGI backend | The root script delegates to the backend npm workspace. Its unit script delegates to a fixed clean-and-TypeScript build, then selects `unit` in the Node test harness. The harness uses Node spec on stdout and writes a JUnit file under `reports/`. With the sanitized environment, unit scope does not select service mode or start an in-memory MongoDB instance. |
| DGI frontend | The root script delegates to the frontend workspace, where the Allure wrapper selects Vitest with the fixed `frontend unit run` arguments and a jsdom configuration. The workspace configuration resolves both root and frontend dependency directories. |
| Shared DGI lock | npm v3 records both local workspaces, their exact links, nested dependencies and published-package metadata. The shared lock contains an unapproved postinstall hook in `@vaadin/vaadin-usage-statistics@2.1.3`. Static validation still returns `lifecycle-review` for both DGI profiles. |

### C. Implementation

- CLU accepts a regular root `.npmrc` containing only the approved literal `true` settings. QEP checks it before copying and revalidates it inside the snapshot. The three design-token path exceptions require the reviewed Git blob IDs.
- DGI workspace delegation is restricted to its audited SHA, exact workspace names and exact script chains. The runner creates a fresh private `reports/` directory after integrity checks.
- Install validation checks registry tarball provenance, lock integrity metadata, approved workspace links and the reviewed bundled entries. After installation, QEP checks the dependency roots, package identities and versions, and executable links. It also rechecks the tracked tree and rejects untracked source files outside verified dependency roots.
- npm lifecycle scripts remain disabled. Reviewed skipped hooks are limited to the off-platform fsevents entry, DGI's unused workerd hook and esbuild with the matching locked Linux binary present and executable. An unapproved hook remains a `lifecycle-review` blocker.
- The backend requires a complete Node spec footer with positive, consistent test counts and zero failures or cancellations, in addition to a successful child exit. QEP does not consume JUnit files for evidence. The summary retains the Run Summary v0 fields.

### D. Regression results

`npm run build`, `npm run typecheck`, `npm run lint` and `git diff --check` passed. The seven direct policy tests passed, and a standalone Node fixture confirmed that the parser accepts genuine spec reporter output.

`npm test` exited 1. The policy and CLI test files passed. The plan, runner and workspace suites failed in the restricted session. A direct invocation reproduced `spawnSync git EPERM` during fixture setup. Existing timeout, cancellation and lock-ownership coverage remains in the standard suite. The install fixture was updated to describe a real lock entry and installed manifest under the stricter policy. No sandbox workaround or skipped test was used.

### E. Real source execution

The platform gate did not clear, so no source smoke run or dependency installation started during remediation. Read-only checks accepted the pinned CLU tree, command and install metadata. They accepted both DGI trees and script chains, then returned `lifecycle-review` when checking the shared lock. These checks created no run summaries.

### F. Remediation run provenance

| Suite | Verified source SHA | Run ID | Phase | Status | Exit code | Expected evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `clu-unit` | `84c2b3435b63e6290e6bc60578d6a6dc6665e465` | Unassigned | Before reservation | BLOCKED by platform gate | Unavailable | Absent |
| `dgi-backend-unit` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | Unassigned | Before reservation | BLOCKED by platform gate | Unavailable | Absent |
| `dgi-frontend-unit` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | Unassigned | Before reservation | BLOCKED by platform gate | Unavailable | Absent |

### G. Source integrity

DGI and CLU stayed clean at their approved SHAs and retained the same Git index checksums. The two original DGI summaries are still present, with no new source-run directory.

### H. Security boundaries

The private-path scanner, explicit SHA validation, sanitized child environment and private npm home, cache and temporary directories remain in effect. Disposable Git workspaces provide filesystem separation for ordinary writes. Tests still run with the effective OS permissions. No Docker or database command, dotenv read or private environment write occurred during remediation.

### I. GitHub CI readiness

The QEP-only workflow remains ready for review. Its hosted result is pending. The standard test suite still needs to pass on a runner that permits its subprocess fixtures.

### J. Recommendation

**NO-GO for formal acceptance.** A passing standard QEP test run is required before the sequential source smoke. DGI's unresolved lifecycle marker needs separate review. Formal acceptance also requires positive evidence and a sanitized v0 summary from each source suite.

## INFRA-04.2.5 — Pragmatic MVP Acceptance

QEP v0.1 is a personal TypeScript portfolio MVP. Acceptance now covers the platform and its orchestration fixtures. End-to-end compatibility with each external project is deferred so it can be validated independently. The earlier smoke attempts and their outcomes above remain historical evidence.

An otherwise valid third-party registry lock entry may contain `hasInstallScript`. QEP still uses `npm ci --ignore-scripts --include=dev`, validates registry and lock integrity, and rejects unapproved local references, external sources and source hooks. A dependency that needs a skipped hook can fail during installation or testing. The runner reports that failure with hooks still disabled.

| Gate | Scope | Result |
| --- | --- | --- |
| 1. Build, typecheck and lint | Required | PASS. Each command exited 0. |
| 2. Standard QEP tests in a supported environment | Required | PENDING. Unverified in a supported environment. The Codex run exited 1. |
| 3. Hosted GitHub Actions QEP CI | Required before merge | PENDING. Workflow configuration checked locally. |
| 4. DGI and CLU source preservation | Required | PASS. Both source checkouts stayed clean at the approved SHAs with matching index checksums. |
| 5. Execution and secrets safety boundaries | Required | PASS. The policy change is limited to dependency metadata. Install flags, source validation, execution controls and environment sanitization remain in effect. |
| 6. README, architecture, runbook and acceptance evidence | Required | PASS. The documents describe the current policy, verification status and scope. |
| 7. Real CLU unit smoke | Non-blocking | DEFERRED. Implemented catalog entry, real-source integration unverified. |
| 8. Real DGI backend unit smoke | Non-blocking | DEFERRED. Implemented catalog entry, real-source integration unverified. |
| 9. Real DGI frontend unit smoke | Non-blocking | DEFERRED. Implemented catalog entry, real-source integration unverified. |
| 10. Allure aggregation and cross-repository testing | Non-blocking | DEFERRED. |

**ENVIRONMENT-LIMITED.** Git subprocess creation is blocked by the current Codex execution sandbox. The standard `npm test` invocation exited 1, and a direct plan test invocation reproduced `spawnSync git EPERM` in fixture setup. The seven focused policy tests passed and `git diff --check` exited 0. These focused results do not verify the standard test gate. See the [Ubuntu validation commands](runbook.md#validate-qep-on-ubuntu).

The workflow configuration is unchanged. A passing standard suite in a normal Ubuntu terminal or GitHub Actions can verify the standard test gate. A passing hosted QEP CI job is required before final merge. No real source suites were run during finalization. Full DGI workspace compatibility, production-level sandboxing, artifact retention and cleanup, and further dependency-policy abstractions remain deferred.

**READY for a manual Draft PR. NO-GO for final merge** until the two test and CI gates are verified.
