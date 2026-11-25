# INFRA-04.4 ACCEPTANCE PREPARATION REPORT

Prepared on 2026-11-25 UTC for INFRA-04.4.5. **GO for owner review and local report generation. Formal acceptance is pending owner-generated evidence and independent verification.**

## A. Implementation status

The QEP checkout started clean on `test/infra-04.4.5-acceptance`. Its HEAD matched the upstream branch and local `origin/main` at `f3b2b819fc685144efe40e80800f53bd44072ea8`. Local first-parent history confirms these merges.

| Milestone | Implementation | Merge |
| --- | --- | --- |
| 04.4.1 | Contract v1 to Allure result exporter | `0e1aa13` (#15) |
| 04.4.2 | Pinned Allure 3 generator | `204d6e8` (#16) |
| 04.4.3 | Unified report plan, build and verify CLI | `3d315a8` (#17) |
| 04.4.4 | Local Allure history and verified report reuse | `f3b2b81` (#18) |

Acceptance preparation adds QEP-only CI coverage and documentation. The workflow includes the standalone pinned generator fixture and identifies the exporter, assembly and history coverage in the standard suite. Its existing Contract v1 and adapter step remains part of CI. [QEP CI](../.github/workflows/ci.yml) · [Architecture](allure3-architecture.md)

## B. QEP regression tests

| Check | Result |
| --- | --- |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS, 173 tests and zero failed, cancelled or skipped. Includes all 150 pre-04.4 QEP tests, nine exporter tests and 14 report CLI tests. |
| Hosted QEP CI for these preparation changes | BLOCKED pending a hosted run on the changes. |

Validation used Ubuntu 26.04.1, Node.js 22.23.4, npm 10.9.9 and Git 2.53.0. The initial managed sandbox run encountered subprocess restrictions. The ordinary Ubuntu retry passed the standard suite and standalone generator fixture. The tests used QEP fixtures and temporary directories.

## C. Allure 3 generator verification

The standalone synthetic fixture used the pinned Allure 3.33.0 CLI and generated a static Awesome report with `index.html`, `summary.json` and `test-results.json`. The summary recorded six cases, with one passed, two failed, one broken, one skipped and one unknown. The fixture preserved its synthetic inputs, and the generated HTML passed the local content policy check.

The unified CLI fixtures passed report generation and verification with all three synthetic suites. They also checked duplicate selectors, tampered input digests, unsuccessful runs, repeated logical cases, partial output and incorrect case inventories. The approved historical selection was verified and planned read-only. [Owner commands](allure3-runbook.md#0445-owner-preflight-and-plan)

## D. Three verified input runs

All three run directories exist under `.local/runs`. `qe results verify` exited 0 for each and reproduced the retained Contract v1 result and manifest from the original evidence. Each run recorded Summary v0 and Contract v1 `PASS`, child exit `0` and collection state `COMPLETE`.

| Suite | Run UUID | Source SHA | Passed |
| --- | --- | --- | ---: |
| DGI backend | `af9dbaab-a9ba-40d3-b285-3762d8a2b558` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | 189 |
| DGI frontend | `4f258528-22f4-4b99-9f38-5c65d282da5b` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | 257 |
| CLU unit | `01ca49e4-dc10-4317-8362-99ec59dcf372` | `8bda12f627e6234ed122fef29b48bd5ee2e2706d` | 83 |
| **Total input cases** | | | **529** |

All nine Summary v0, Contract v1 result and Contract v1 manifest hashes matched the 04.3 closure and remained identical across preparation. [04.3 accepted digests](acceptance-04.3.md#e-contract-v1-and-manifest-verification)

## E. Report case reconciliation

The read-only plan reported 529 passed and zero failed, broken, skipped or unknown from three input runs. A separate in-memory export audit reconciled 529 result records (161,091 bytes) one-to-one with the verified contracts. It found 529 distinct case IDs, execution IDs, exported Allure UUIDs and expected rendered case IDs. The audit checked the UUID derivation, status and approved labels for each record.

Reconciliation against `summary.json`, `test-results.json` and the embedded HTML case data is **BLOCKED** pending the owner's real static report.

## F. Report manifest and provenance

The read-only plan identified Allure `3.33.0`, policy `qep-audited-pass-v1` and report ID `4a01f5da12c7404e80d4b1317eb312685e16f9cc85387f665d29828e264df6ee`. The plan reported the intended path under `.local/reports` and bound each UUID and source SHA to the verified result and manifest hashes. The unified report root was absent throughout preparation.

The owner's build will provide the schema-v2 manifest, static `index.html`, `summary.json`, `test-results.json` and `history.jsonl`. Manifest, file inventory, output digests and rendered data verification remain **BLOCKED**. The runbook provides exact Ubuntu commands and specifies the private evidence to retain. [Owner build, verify and retry](allure3-runbook.md#owner-build-verify-and-retry)

## G. History and idempotency tests

The QEP fixtures verified unchanged bytes on same-selection reuse, one history line per distinct launch, stable case matching across launches, writer exclusion, retry after a killed build, and reuse of schema-v1 reports. They verified that generator failure, timeout, invalid staged history, and corrupt or missing accepted history withhold publication and preserve prior accepted data. The first real history receipt, report reuse and byte-for-byte idempotency remain **BLOCKED** pending owner evidence.

## H. Security and storage audit

Preparation used read-only historical verification and temporary synthetic reports. `.local` and `.local/runs` were mode `0700`. The retained summary and Contract v1 files were mode `0600`, and `.local/runs` and `.local/reports` are Git-ignored. The synthetic checks verified the export allowlist, omission of diagnostic data and template analytics, and private output and history behavior. Review of the real report's rendered data and file modes remains **BLOCKED**.

DGI and CLU suites were untouched. Preparation used no Docker, sudo, database changes, secrets, Nginx, persistent server or external publishing. No commits, pushes or merges were made.

## I. Deferred scope

Owner review and generation of the selected historical launch and independent verification of the real report remain acceptance work. The CI changes await hosted execution. INFRA-04.5 hosting, public publishing, external storage, automatic retention, cross-repository consumer and candidate testing, and branch protection are future work.

## J. PASS / FAIL / BLOCKED matrix

| Acceptance item | Decision |
| --- | --- |
| Merged 04.4.1–04.4.4, expected branch and clean starting baseline | PASS |
| QEP build, typecheck, lint and 04.2/04.3 regressions | PASS |
| Synthetic exporter, static generator, assembly, verification and history | PASS |
| Historical run verification, counts, identity and original file integrity | PASS |
| Read-only plan and in-memory export reconciliation of the three inputs | PASS |
| Hosted QEP CI for preparation changes | BLOCKED |
| Owner-generated static report, 529 rendered cases and verified provenance | BLOCKED |
| Real manifest, file digests, history, reuse and diagnostic payload audit | BLOCKED |

## K. GO / NO-GO recommendation

**GO** for owner review and execution of the local Ubuntu report commands. **NO-GO** for formal closure until the real report is generated and independently verified. The 529 passing cases recorded here are the verified historical inputs and their in-memory exports.
