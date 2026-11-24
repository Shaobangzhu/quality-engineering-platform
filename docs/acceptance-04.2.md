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

## INFRA-04.2.6 — DGI frontend evidence compatibility

### Incident

The D.2 `dgi-frontend-unit` run `f028d875-e5cb-4ea0-bf3f-04f56b969083` finished in phase `test` with child exit 0, CLI exit 1, and `FAIL / missing-evidence`. A read-only Git check verified the exact disposable workspace had detached HEAD at the approved DGI commit `2ef00a81e55e7d150770bfc81abffd96dffdc0b3`. The audit of that workspace recorded the following results.

| Evidence | Exact workspace result |
| --- | --- |
| Audited Allure manifest | Schema version 1, scope `frontend/unit`, dataset `synthetic-only-v1`, `testExitCode` 0, counts `{"passed":257}`. |
| JUnit | 257 test cases, all passed, with zero failures, errors, and skips. |

The original child console was unavailable. The baseline parser recognizes the independently observed native Vitest line `Tests  257 passed (257)` and ignores the reviewed `Allure audited frontend/unit: {"passed":257}` footer. A synthetic regression produced `missing` where `passed` was expected against the baseline. The exact stream content and reason the original run lacked recognized evidence remain unknown.

### Remediation

Only the existing SHA-pinned DGI frontend workspace chain selects the new evidence format. It requires one complete, bounded footer on stdout and child exit 0. The footer accepts a positive safe-integer `passed` count and optional zero counts for `failed`, `broken`, `unknown`, and `skipped`. Malformed, oversized, duplicate, and conflicting target footers fail. Stderr can veto stdout evidence, and recognized failed or contradictory console evidence on either pipe vetoes a pass. The footer is a source-produced signal whose trust derives from the approved workload and pinned checkout. It supplies no cryptographic attestation.

The change is limited to evidence selection and recognition. The v0 summary schema, process outcome precedence, and standard and backend reporter policies are preserved. The four historical summaries retained their original SHA-256 checksums. Real-source repositories and historical run workspaces were left untouched.

### Validation

| Gate | Result |
| --- | --- |
| Build, typecheck, lint and Git whitespace checks | PASS. |
| Focused synthetic regression and compatibility tests | PASS, 6 of 6, including the test that spawns real synthetic child processes. |
| Standard `npm test` | BLOCKED in the restricted session. The command exited 1 and reported 2 passing and 3 failing test files. The in-process diagnostic enumerated 46 tests, with 15 passing and all 31 failures reporting `spawnSync git EPERM` during existing fixture setup. |
| Full suite on ordinary Ubuntu and hosted QEP CI | NOT VERIFIED for this change. Run the [Ubuntu QEP validation commands](runbook.md#validate-qep-on-ubuntu) before merge and verify hosted CI. |
| DGI frontend real-source retry and Level B evidence | NOT VERIFIED. Post-merge revalidation is pending in a fresh approved QEP workspace. |
| Structured JUnit/Allure ingestion and the 04.3 Result Contract | DEFERRED. |

## INFRA-04.2.7 — Package boundary-aware dependency verification

### Incident

The Level B `clu-unit` run `6b718aea-6689-4326-a30d-f7f792fc111e` at source SHA `84c2b3435b63e6290e6bc60578d6a6dc6665e465` finished `BLOCKED / integrity` in phase `test`. The CLI exited 2 and the test child exit code was `null`. Dependency installation succeeded, and `inspectSuite()`, `checkInstall()`, and `verifyCheckout()` passed. `verifyDependencies()` blocked at `dist/install-policy.js:191:19` when `scanPackage()` found no lock entry for a path reached through a package fixture directory.

The incident investigation identified the following two published files in `resolve@1.22.14`.

- `node_modules/resolve/test/resolver/symlinked/_/node_modules/foo.js`
- `node_modules/resolve/test/shadowed_core/node_modules/util/index.js`

The registry archive recovered from the run-local npm cache matched the committed lockfile SHA-512 integrity value. SHA-256 comparisons matched both installed files to their respective archive contents. The remediation used synthetic fixtures and left the historical summaries and workspaces untouched.

### Remediation

Each verified installed package establishes its own traversal root. A `node_modules` immediately beneath that root goes through strict dependency verification. Deeper directories with the same name, including any `.bin` content, go through recursive filesystem checks that reject symlinks, hard-linked files, and unsupported objects. Each verified nested dependency establishes a new root.

The existing checks for top-level and direct dependency roots, scopes, required lock entries, package identity and version, exact workspace links, dependency `.bin` targets, required dependencies, and test tool presence continue to apply. Registry URL and integrity checks, bundled-package and published-workspace restrictions, source lifecycle restrictions, and post-install Git checkout verification remain in effect. The trust model continues to rely on reviewed workloads, registry-constrained lockfiles, npm integrity verification, and structural checks of the installed tree.

### Validation

The Stage A focused run exited 1 with 17 of 22 tests passing. Both ordinary fixture layouts and the three ordinary-file controls in the filesystem rejection tests reached the confirmed integrity gate. After the fix, both layouts passed, and the linked-file and FIFO rejection tests passed with their regular-file controls. The focused suite also checked nested dependency roots across package boundaries, undeclared packages, identity and version mismatches, invalid actual dependency `.bin` targets, ordinary deep fixture `.bin` contents, and workspace links.

| Command | Result |
| --- | --- |
| `npm run build`, `npm run typecheck`, `npm run lint` | Each exited 0. |
| `node --test --experimental-test-isolation=none --test-reporter=spec test/acceptance-policy.test.js` | Exited 0 after the fix. All 23 tests passed, with 0 failures, skips, or cancellations. |
| `npm test` | Exited 1. At file level, 2 of 5 passed and 3 failed, with 0 skips or cancellations. |
| `node --test --experimental-test-isolation=none --test-reporter=spec test/*.test.js` | Exited 1. Of 59 tests, 28 passed and 31 failed, with 0 skips or cancellations. All failures reported `spawnSync git EPERM` during existing fixture setup in the restricted session. |

Full-suite validation on ordinary Ubuntu, hosted QEP CI, and fresh CLU real-source revalidation remain pending. This entry records remediation of the dependency-verification defect while Level B acceptance remains open.

## INFRA-04.2.8 — Reporter environment and ANSI evidence compatibility

The real `clu-unit` run `ff11ca99-7d20-4ab1-8333-e08f718dcd63` at source SHA `84c2b3435b63e6290e6bc60578d6a6dc6665e465` reached phase `test` after the INFRA-04.2.7 dependency fix. The child exited 0 and QEP exited 1 with `FAIL / missing-evidence` after 5,677 ms. The recorded summary SHA-256 is `fd5a0414fc8c6e39f0acafdb4ecb0a2b01e42820fb4c846815374557245948a2`. The historical raw child output was intentionally omitted from retention and remains unavailable.

The confirmed environment incompatibility was in `tinyrainbow@2.0.0`. It checks for the presence of `FORCE_COLOR` and `CI`, so the controlled values `FORCE_COLOR='0'` and `CI='true'` could still enable styling. `NO_COLOR` disables that detection path. D.3-R.11 exercised synthetic summaries against the original standard parser.

| Synthetic input | Original result |
| --- | --- |
| Plain Vitest summary | `passed` |
| Colored `Tests` label | `missing` |
| Colored passed count | `missing` |
| Colored entire summary | `missing` |
| Colored total count | `missing` |
| Plain failed summary | `failed` |
| Colored failed summary | `passed` |
| Missing evidence | `missing` |

The four styled positive cases were false negatives. The line `Tests  \x1b[31m1 failed\x1b[39m | 24 passed (25)` was a confirmed synthetic false positive. The count of 25 belongs to the fixture. These results establish the parser defects independently of the unavailable CLU stream.

The controlled environment sets `NO_COLOR='1'` and excludes `FORCE_COLOR`, including when the host sets it. CI, private home, temporary directory and npm cache, lifecycle restrictions, executable resolution, and secret isolation retain their existing policies.

Only standard evidence strips SGR after bounded line assembly. It supports `ESC[m` and decimal parameters separated by semicolons. Private and colon-delimited forms, empty fields in parameter lists, cursor motion, OSC, backspace, embedded carriage returns, and malformed or incomplete escape sequences are unsupported. Tabs, CRLF, and a final line at EOF remain supported. The 4,096-character limit applies to raw input. Unsupported controls veto a standard pass. Overlong lines with evidence-like or ambiguous bounded prefixes veto a pass, while ordinary overlong lines can be skipped. Recognized failure on either stream still takes precedence over positive evidence.

The DGI node-spec and audited Allure contracts retain their original interpretation. The Allure footer still requires valid raw evidence on stdout, with rejection of duplicate or malformed footers, conflicting console counts, nonzero failure or skip counts, and negative evidence on stderr. Exit codes, cancellation, timeout, process-group cleanup, and the v0 summary contract are unchanged.

| Validation | Result |
| --- | --- |
| Build, typecheck, lint, and Git whitespace checks | Each exited 0. |
| Focused baseline RED | Exit 1. 18 of 45 passed, with 21 failing case assertions and six failed parent groups. The parser and exit-zero child both reproduced the false pass. |
| Focused implementation GREEN | Exit 0. All 48 passed, including test groups and cases. The exact colored failure returned `failed` in the parser and `FAIL / failed-evidence` with child exit 0 and CLI exit 1 in the process fixture. |
| Audited DGI evidence checks | Exit 0. All 4 passed. |
| Standard `npm test` | Exit 1 in the restricted session. Two of five test files passed and three failed. |
| Full diagnostic with `--experimental-test-isolation=none` | Exit 1. Of 107 tests, 76 passed and 31 failed with `spawnSync git EPERM` during existing fixture setup. Zero skips or cancellations. The count includes the 59 original tests and 48 focused regression groups and cases. |

Full-suite validation in an environment that permits the existing Git subprocess fixtures and hosted QEP CI remain pending. Fresh real-source CLU and both DGI suite runs remain pending after merge. The implementation did not access historical run workspaces or summaries.

### INFRA-04.2.8-B-R1 — Standard failed Test Files veto

Independent Stage C review returned NO-GO after an exit-zero synthetic child emitted the following two stdout lines (`\x1b` denotes ESC).

```text
Test Files  1 failed | 1 passed (2)
\x1b[32mTests  24 passed (24)\x1b[0m
```

The original HEAD parser returned `missing`. The initial INFRA-04.2.8 working tree returned `passed` and `runProcess` returned `PASS` with child and CLI exit codes of 0. A file can fail during collection while all tests collected from other files pass.

Standard evidence now applies the existing failed-file check after SGR normalization. A nonzero failed-file count on either stream vetoes positive evidence in either order. An overlong line with an evidence-like `Test Files` prefix uses the existing bounded ambiguity veto. A valid zero failed-file count leaves positive evidence eligible. The corrected parser returned `failed` for the reproduction. Both the exact reproduction and the cross-stream synthetic process fixture returned `{ status: 'FAIL', failureCategory: 'failed-evidence', exitCode: 0, cliCode: 1 }`.

| Validation | Result |
| --- | --- |
| Focused parser and process regressions before the fix | Exit 1. 7 of 17 passed. Six parser cases and two process cases reproduced false passes, causing their two parent groups to fail. |
| Same focused regressions after the fix | Exit 0. All 17 passed. |
| Expanded ANSI, environment, process, and DGI checks | Exit 0. All 63 passed. |
| `npm run build`, `npm run typecheck`, `npm run lint` | Each exited 0. |
| `npm test` | Exit 1. Two of five files passed and three failed in the restricted session. |
| `node --test --experimental-test-isolation=none --test-reporter=spec test/*.test.js` | Exit 1. Of 118 tests and groups, 87 passed and 31 failed with `spawnSync git EPERM` during existing fixture setup. Zero skips or cancellations. |

Independent re-review, ordinary Ubuntu full-suite verification, hosted CI, and fresh real-source acceptance remain pending. Historical raw CLU output remains unavailable and Level B acceptance remains open.

## Final Level A and Level B Acceptance — 2026-11-24

### Decision

On November 24, 2026, the project owner issued **GO — ACCEPTED** for both Level A — Pragmatic MVP and Level B — Original Full Scope of INFRA-04.2 — Repository Foundation & TypeScript Test Orchestrator. Technical implementation is **COMPLETE**, with no outstanding technical blockers or further INFRA-04.2 remediation. Repository documentation closure is in progress.

This addendum supersedes earlier open acceptance decisions as the current milestone status. Historical pending, NO-GO, BLOCKED and FAIL statements remain accurate records of their respective execution stages. All historical outcomes retain their original status.

### Accepted Git baselines and pull requests

| Repository | Branch | Accepted SHA |
| --- | --- | --- |
| `quality-engineering-platform` (QEP) | `main` | `e769d14dc3374c6c6eabd951a480a593bca3856c` |
| `delivery-geo-intelligence` (DGI) | `main` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` |
| `react-clu-component-lib` (CLU, package `@shaobangzhu/clu-ui`) | `master` | `84c2b3435b63e6290e6bc60578d6a6dc6665e465` |

The previous QEP baseline was `59013489bb9e8c6f3ba837c000c2d0aca329d40d`. All three original repositories passed the final branch, HEAD and clean-working-tree checks. DGI and CLU source Git index checksums matched their frozen baselines.

All eight implementation pull requests were merged. The final implementation PR merged at `2026-11-24T17:31:29Z`, producing the accepted QEP main SHA above. [PR #8](https://github.com/Shaobangzhu/quality-engineering-platform/pull/8)

| PR | Scope |
| --- | --- |
| #1 | Repository and CLI foundation |
| #2 | TypeScript suite catalog |
| #3 | Isolated workspace provisioning |
| #4 | Test execution orchestrator |
| #5 | CI and Pragmatic MVP acceptance |
| #6 | INFRA-04.2.6 — DGI test evidence compatibility |
| #7 | INFRA-04.2.7 — Package boundary-aware dependency verification |
| #8 | INFRA-04.2.8 — Reporter environment and ANSI evidence compatibility |

### Hosted CI evidence

QEP CI concluded **SUCCESS** at the accepted QEP main SHA. Workflow run ID `45449533366`, job ID `138642468608`. [QEP CI run](https://github.com/Shaobangzhu/quality-engineering-platform/actions/runs/45449533366)

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` | PASS. npm reported zero vulnerabilities during this installation. |
| Build, typecheck and lint | PASS for each |
| Standard QEP tests | 118/118 PASS. Failed 0, cancelled 0, skipped 0, TODO 0. Duration 10493.285829 ms. |

### Ordinary Ubuntu validation

Post-merge D.0-R3 ran in an ordinary Ubuntu Remote-SSH terminal with Node.js `v22.23.4`, npm `10.9.9`, Git `2.53.0` and Linux with procfs.

| Check | Result |
| --- | --- |
| Production build, typecheck and lint | PASS for each |
| Standard QEP tests | 118/118 PASS. Failed 0, cancelled 0, skipped 0, TODO 0. Duration 11425.003772 ms. |
| Original ANSI false-positive regression | PASS |
| Failed `Test Files` veto | PASS |
| Synthetic process regression | PASS |
| Read-only suite plans | 3/3 PASS |

The earlier restricted sessions recorded `spawnSync git EPERM` during Git fixture setup. Subsequent ordinary Ubuntu and hosted CI runs both passed all 118 standard tests at the final implementation baseline, resolving the open standard test gate.

| Regression milestone | Standard tests and groups passed |
| --- | --- |
| INFRA-04.2.5 | 42/42 |
| INFRA-04.2.6 | 46/46 |
| INFRA-04.2.7 | 59/59 |
| INFRA-04.2.8 | 118/118 |

The final standard regression inventory contains 76 more tests and groups than the original MVP. These counts describe the regression inventory.

### Read-only plan results

All three plans passed on the accepted QEP baseline. Each identified the reviewed source, full source SHA, fixed catalog command, intended per-run workspace and future artifact path.

| Suite | Catalog command | Database required | Docker required |
| --- | --- | --- | --- |
| `dgi-backend-unit` | `npm run test:backend:unit` | false | false |
| `dgi-frontend-unit` | `npm run test:frontend` | false | false |
| `clu-unit` | `npm test` | false | false |

Planning created no real run workspaces and executed no source tests or source dependency installations.

### Final real-source execution evidence

Each run used Node.js `v22.23.4`, reached phase `test` and recorded an independent run ID and Summary v0. All three ran against the accepted QEP baseline `e769d14dc3374c6c6eabd951a480a593bca3856c`. The external acceptance procedure established the QEP SHA association and CLI exit codes. Summary v0 retains its existing schema.

| Stage and suite | Evidence format | Run ID | Source SHA |
| --- | --- | --- | --- |
| D.1-R3 `dgi-backend-unit` | `node-spec` | `6967b27a-cc8e-469e-ad67-bd72c3a514bf` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` |
| D.2-R3 `dgi-frontend-unit` | `dgi-frontend-allure` | `268e7f99-df04-47ba-a84b-f7beb0b158e8` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` |
| D.3-R2 `clu-unit` | `standard` | `812acd8a-ed7c-4d5c-8e90-a4b495ebc1ab` | `84c2b3435b63e6290e6bc60578d6a6dc6665e465` |

| Stage | Started (UTC) | Ended (UTC) | Recorded duration | Status | Child exit | CLI exit | Failure category |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D.1-R3 | `2026-11-24T18:54:40.247Z` | `2026-11-24T18:54:53.504Z` | 13257 ms | PASS | 0 | 0 | `null` |
| D.2-R3 | `2026-11-24T18:57:44.748Z` | `2026-11-24T18:58:07.462Z` | 22714 ms | PASS | 0 | 0 | `null` |
| D.3-R2 | `2026-11-24T18:59:56.146Z` | `2026-11-24T19:00:01.732Z` | 5584 ms | PASS | 0 | 0 | `null` |

| Stage | Summary SHA-256 |
| --- | --- |
| D.1-R3 | `981a3384b24782ab73c3ae24534f951d86d5f5d795f4e6cab4e5f4f7fba21bb2` |
| D.2-R3 | `1529be5026295e6dd45fa78f330266ae05c73159cb9b0306793398cde8757773` |
| D.3-R2 | `489b94a35249481034e9b742fae5e9e0acc89968224d75215e3b6f1148cdea92` |

CLU ran with Vitest `4.1.12`. Summary v0 retained no exact passed-test count for CLU or DGI backend. The table preserves the reported CLU duration of 5584 ms. Its displayed timestamps span 5586 ms.

### Structured evidence cross-check

The acceptance audit inspected two files independently inside the D.2-R3 isolated run workspace. Both agreed on 257 passing DGI frontend tests.

| Artifact | Verified evidence |
| --- | --- |
| Allure manifest at `artifacts/allure-results/frontend/unit/dgi-manifest.json` | Schema version 1, layer `frontend`, execution `unit`, dataset `synthetic-only-v1`, test exit code 0, counts `{"passed":257}` |
| JUnit XML at `reports/frontend.xml` | 257 test cases, 257 passed, 0 failures, 0 errors and 0 skipped |

### Final integrity audit

D.4 was read-only. The audit performed no tests, dependency installations, builds or new runs.

| Item | SHA-256 |
| --- | --- |
| Accepted merged patch | `e94dd673337f40a84bd6387a4b4952b9c217d098e7233954ba40837ae84a435e` |
| Compiled CLI | `38332b5f7776b68ac96db1f6bc7778e898509cdbcce09ac17767b2b4a701d5da` |
| Compiled DIST | `1c314e6338810e48d929ad96c655048d606f27caf4aea7d817cd827c01d18870` |
| DGI source Git index | `8a02073df39fcfc20bf3712983720983033a2e4848f454a0611f88980b8b9073` |
| CLU source Git index | `45e66b1568e43434a2b6d96e3a2f7b8afb1bf3598ae5258978c7da1fc266f8e2` |

| Audit check | Result |
| --- | --- |
| Historical summary checksums | 14/14 MATCH |
| Exact historical inventory | PASS |
| Source Git integrity | PASS |
| Compiled output integrity | PASS |
| Accepted merged patch integrity | PASS |
| Workspace provenance | 3/3 PASS. Each workspace had the correct source SHA, a detached HEAD, no Git remotes and an independent run ID. |
| DGI frontend structured evidence | 257/257 PASS |
| CLU Vitest version | `4.1.12` |
| Execution lock | Absent |

### Historical run inventory

The audit verified 14 historical summaries with 9 PASS, 2 FAIL and 3 BLOCKED.

| Run ID | Suite | Outcome |
| --- | --- | --- |
| `af19df60-de21-4bcc-b137-13cfeed85d9f` | `dgi-backend-unit` | BLOCKED |
| `c4392f33-1bd4-416b-bc56-64b3fb2dfcb6` | `dgi-frontend-unit` | BLOCKED |
| `69db7998-0a4b-4dad-b3bb-4aefcc3ac462` | `dgi-backend-unit` | PASS |
| `f028d875-e5cb-4ea0-bf3f-04f56b969083` | `dgi-frontend-unit` | FAIL |
| `17ae8beb-9cef-442c-ad8f-42b349656c45` | `dgi-backend-unit` | PASS |
| `19512fc2-b8de-41cb-b4b8-fec212fa72d5` | `dgi-frontend-unit` | PASS |
| `36fd4853-fb18-411e-bb9a-d5f15fcb6612` | `dgi-frontend-unit` | PASS |
| `6b718aea-6689-4326-a30d-f7f792fc111e` | `clu-unit` | BLOCKED |
| `a9ec2d96-7236-44fc-a502-8d135cf88195` | `dgi-backend-unit` | PASS |
| `ff272a4d-623f-477f-86e2-60ec725015c9` | `dgi-frontend-unit` | PASS |
| `ff11ca99-7d20-4ab1-8333-e08f718dcd63` | `clu-unit` | FAIL |
| `6967b27a-cc8e-469e-ad67-bd72c3a514bf` | `dgi-backend-unit` | PASS |
| `268e7f99-df04-47ba-a84b-f7beb0b158e8` | `dgi-frontend-unit` | PASS |
| `812acd8a-ed7c-4d5c-8e90-a4b495ebc1ab` | `clu-unit` | PASS |

### Known limitations and deferred scope

- Acceptance is limited to the reviewed workloads and pinned source revisions.
- Isolated workspaces separate ordinary filesystem writes. Complete OS-level sandboxing is outside the runner's scope.
- Git status and index checksums verify tracked Git state. Every ignored source file's contents cannot be inferred from these checks.
- Structural dependency verification covers installed layout and metadata. Full package-archive attestation is outside its scope. npm's zero-vulnerability result is limited to the reported installation.
- QEP retains no raw child stdout or stderr. The exact historical CLU console stream remains unavailable and cannot be reconstructed. Synthetic checks reproduced the ANSI compatibility defects independently.
- Summary v0 remains unchanged. The acceptance audit inspected the DGI frontend structured artifacts directly. Generalized result ingestion and unified Allure 3 aggregation remain deferred.

### Final Level A and Level B acceptance matrix

| Level | Accepted evidence | Decision |
| --- | --- | --- |
| A — Pragmatic MVP | CLI, fixed catalog, read-only planning, isolated workspace provisioning, controlled execution and Summary v0. Standard Ubuntu and hosted CI gates passed 118/118 each. All three read-only plans passed. | **GO — ACCEPTED** |
| B — Original Full Scope | All three pinned real-source suites passed under the accepted QEP baseline. Final audit verified source and workspace provenance, compiled output, merged patch, 257/257 DGI frontend structured results and 14/14 historical summary checksums. | **GO — ACCEPTED** |

### Documentation closure and future milestones

The documentation update records the owner's acceptance and is subject to independent review. The accepted implementation baseline remains `e769d14dc3374c6c6eabd951a480a593bca3856c` after a documentation-only merge.

INFRA-04.3 — Result Contract implementation is **NOT STARTED**. Unified Allure 3 reporting, cross-repository consumer/candidate testing and INFRA-04.8 branch protection remain deferred.
