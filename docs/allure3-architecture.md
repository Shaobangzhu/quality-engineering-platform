# Centralized Allure 3 architecture

QEP combines explicitly selected, verified Contract v1 runs into one private static Allure 3 report. It uses evidence already collected by the DGI Allure and CLU JUnit adapters. The reporting CLI does not execute source tests.

## Implemented pipeline

```text
Explicit QEP run UUIDs
  → Read-only verification of Summary v0, reporter evidence and Contract v1 pair
  → Deterministic report plan and minimal Allure result export
  → Private staging with the pinned Allure 3.33.0 generator and accepted history
  → Reconciliation of rendered cases, counts, inventory and history
  → Atomic publication of the local HTML report, manifest and one history entry
```

| Step | Function |
| --- | --- |
| Verify inputs | Reconstruct each Contract v1 pair from the retained evidence and compare bytes. The `qep-audited-pass-v1` policy requires an audited run at its catalog SHA, Summary v0 and Contract v1 `PASS`, child exit `0`, `COMPLETE` collection, positive passed evidence, and zero failed, broken or unknown cases. Verified skipped cases are allowed. |
| Export | Emit bounded, deterministic Allure result JSON. The logical case ID is suite-scoped, the Allure UUID derives from the Contract v1 execution ID, and repeat executions of a logical case in the same launch get separate occurrence slots. |
| Generate | Invoke the locally installed `allure@3.33.0` in a private directory. The Awesome plugin produces a single-file `index.html` with embedded viewer assets and data, plus two JSON files for machine checks. |
| Verify output | Compare counts, case and retry identities, approved metadata, and history across the report summary, the case index and the rendered HTML data. Verify the inventory and file digests. Recheck source evidence before publishing a new report. |
| Publish locally | Rename a complete private directory into `.local/reports/<reportId>/`. The schema-v2 manifest records policy, generator, input run provenance and digests, counts, the history receipt and artifact digests. |

`qe report plan` revalidates the selection and export limits in memory. The report ID is the SHA-256 of the UTF-8 JSON serialization of `["qep-report-v1", [[runId, manifestSha256], ...]]`, with Run IDs sorted. The same selection and evidence yield the same ID. `qe report verify` is read-only. `qe report build` verifies an existing destination before returning `reused`.

## Inventory and history

| File | Purpose |
| --- | --- |
| `index.html` | Static single-file Allure report with the current launch and its rendered history. |
| `summary.json` | Generator metadata and aggregate counts. |
| `test-results.json` | Allure’s machine-readable case index. |
| `history.jsonl` | One accepted Allure launch entry. |
| `report-manifest.json` | Report identity, input UUIDs and source SHAs, result and manifest hashes, aggregate counts, history receipt, and byte lengths and SHA-256 digests for the other four files. |

A new schema-v2 report adds one history entry, regardless of how many runs it includes. QEP holds an exclusive nonblocking Linux `flock` while checking the accepted sequence, staging the prior JSONL prefix, and publishing the new report. A failed build leaves accepted reports intact. A retry verifies and reuses any report that was already published. Schema-v1 reports remain verifiable and reusable with their original inventory. History starts with the first schema-v2 report.

Allure matches previous results using stable case identities, with separate slots for repeated cases in a launch. The static viewer embeds up to six full prior history entries. The accepted files retain earlier entries within QEP's storage limits. History timestamps identify report generation time. Contract v1 supplies no case timing, so time-based charts are disabled. [Report limits and recovery](runbook.md#local-history-and-recovery)

## Data boundary

QEP exports opaque case names and IDs, statuses and catalog suite and repository labels. Raw reporter names, logs, attachments, stack traces, paths and environment data stay in the run evidence. The generator uses a minimal environment with local paths. QEP disables the agent plugin, publishing, automatic opening and the update notifier. It removes the template analytics block and verifies a local content security policy in the generated HTML.

The QEP account, filesystem and installed generator are trusted. Keep `.local/runs` and `.local/reports` private. The manifest provides integrity checks over the selected inputs and report using local SHA-256 digests. [QEP security boundaries](security-boundaries.md)

## Future work

INFRA-04.5 covers report hosting. Nginx configuration, public publishing, external storage and automatic retention are outside this implementation. Formal INFRA-04.4 acceptance requires owner-generated evidence and independent verification of the real report. [Acceptance preparation](acceptance-04.4.md)
