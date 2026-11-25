# INFRA-04.3.2 verified DGI Allure adapter

`qe adapt-dgi --run-id <uuid>` emits one verified QEP Test Result Contract v1 on stdout. It reads a completed run in the QEP installation's private run storage. A verification error exits 2 with an empty stdout. A verified run with unsuccessful tests retains its execution status and child exit code in the result. [CLI usage](runbook.md#verify-a-completed-dgi-unit-run)

## Evidence checks

| Input | Checks before returning a result |
| --- | --- |
| Run Summary v0 | Exact fields, requested QEP UUIDv4, DGI suite and repository, approved SHA, test phase, timestamps, runtime and consistent terminal outcome with a known child exit code. |
| DGI manifest | Schema 1, matching commit, runtime, layer and child exit, execution `unit`, dataset `synthetic-only-v1`, local environment and `ciRun=local`. The audited unit profile has zero published attachments. |
| Inventory | Exactly one layer and one execution under `workspace/artifacts/allure-results`. The unit directory must contain the manifest and its exact, nonempty inventory of `<64 lowercase hex>-result.json` files. Each record's SHA-256 is checked against the manifest before decoding that record. |
| Case evidence | Each UUID must match its unique filename. The adapter checks audited fields, finished stage, nested step projections, empty attachment lists, status and scope labels. Case times must fall within the selected run. Duplicate logical identities, duplicate JSON members and malformed UTF-8 fail verification. |
| Counts | Tally every canonical case status, compare the tally with the manifest, and validate the completed result with the v1 parser. An absent manifest status contributes zero. |
| Optional JUnit | Read only `reports/backend-unit.xml` or `reports/frontend.xml` for the selected layer. Count structural testcase outcomes and verify any declared suite or root aggregates. A missing report is optional. A present unreadable, malformed or inconsistent report fails verification. The XML parser rejects DTDs and processing instructions. Message attributes, diagnostic text and CDATA supply no counts. |

Case identity uses DGI's audited `historyId` as the logical key to `createCaseId`. The execution ID uses the QEP UUID. Case names, labels, raw diagnostics and paths stay out of the result. The TypeScript API returns `{ result, durationsMs }`. The map keys each rounded, nonnegative `stop - start` duration in milliseconds by execution ID. The CLI serializes only `result`, preserving the three-field v1 case schema. [Adapter](../src/dgi-allure.ts) and [wire contract](result-contract-v1.md)

The implementation opens owned directories with Linux descriptor-relative lookups and rejects symlinks and hardlinked input files. It enumerates the batch incrementally and reads at most 4 KiB for the summary, 2 MiB for the manifest, 256 KiB per case and 4 MiB for optional XML, with a 32 MiB combined budget. Limits also cover JSON nesting, XML depth and elements, and 10,000 cases. The adapter only reads audited unit outputs and never opens the raw attachment directory. SHA-256 binds records to the local manifest. Trust in the producer and run reservation comes from QEP's private workspace and reviewed source policy.

## Verification on 2026-11-25 UTC

| QEP check | Actual result |
| --- | --- |
| `npm run build` | Passed, exit 0 |
| `npm run typecheck` | Passed, exit 0 |
| `npm run lint` | Passed, exit 0 |
| `npm test` | 142 passed, 0 failed, 0 skipped, exit 0 |
| `git diff --check` | Passed, exit 0 |

The standard suite ran with local child-process execution enabled after the restricted environment failed the existing plan, runner and workspace fixture suites. Runtime was Node.js 22.23.4 and npm 10.9.9. The 14 adapter tests use disposable QEP installations and synthetic evidence. They cover both reporter formats, failed and skipped cases, unsupported fields and statuses, digest and inventory changes, duplicate identities, wrong SHAs, empty or mixed batches, inconsistent JUnit and manifest counts, and filesystem boundaries. [Adapter tests](../test/dgi-allure.test.js)

Two historical QEP acceptance workspaces at approved DGI commit `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` were verified read-only. Each result passed the Contract v1 integrity-manifest round trip in memory.

| Suite | QEP run ID | Verified records | Manifest and JUnit | Contract outcome |
| --- | --- | ---: | --- | --- |
| DGI backend unit | `6967b27a-cc8e-469e-ad67-bd72c3a514bf` | 189 passed, 189 durations | Both agree | PASS, COMPLETE, exit 0 |
| DGI frontend unit | `268e7f99-df04-47ba-a84b-f7beb0b158e8` | 257 passed, 257 durations | Both agree | PASS, COMPLETE, exit 0 |

SHA-256 of the CLI result bytes, including the final newline, was `4ae3b205fe9ea8aef6ad68a220d9f618dac5a954fb900ecfea57665fd75a3661` for backend and `9b1f0914fbad2c02ac01ddf38e17e234c5738bdc62023d5d0afd959abb13555c` for frontend.

## Remaining for 04.3.5

Run each pinned real-source unit suite through the QEP runner in a fresh workspace, then invoke the adapter with each newly assigned UUID. Reconcile the new summary, manifest, individual cases and JUnit totals. Compare logical case IDs with the historical run of the same suite, verify distinct execution IDs, and record the exact normalized result digests. The 04.3.2 checks used historical passing executions and synthetic failure cases.
