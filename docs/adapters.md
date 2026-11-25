# Contract v1 adapters

Both adapters consume one QEP run selected by its lowercase UUIDv4. Use the reviewed source SHA and keep the original evidence in that run's private workspace. [Contract v1](result-contract-v1.md) · [Pinned execution commands](acceptance-04.3.md#d-real-source-execution-instructions)

| Catalog suite | Evidence relative to the run directory | Verification |
| --- | --- | --- |
| `dgi-backend-unit` | `summary.json`, `workspace/artifacts/allure-results/backend/unit/`, optional `workspace/reports/backend-unit.xml` | Checks the audited Allure inventory and per-case hashes, source SHA, runtime, scope, exit code, timestamps, identities and counts. A present JUnit report must agree. |
| `dgi-frontend-unit` | `summary.json`, `workspace/artifacts/allure-results/frontend/unit/`, optional `workspace/reports/frontend.xml` | Uses the same audited Allure checks for the frontend unit scope and reconciles a present Vitest JUnit report. |
| `clu-unit` | `summary.json`, `workspace/artifacts/qep/unit.xml`, `clu-junit.receipt` | Requires the reviewed CLU reporter revision. Recomputes the receipt's Summary v0 and XML digests, then checks the JUnit tree, declared counts, outcomes and case identities. |

The DGI adapter uses the audited Allure `historyId` for its logical case key. CLU uses the JUnit ancestor suite names, testcase class and testcase name. Both hash the key within the catalog suite namespace and scope the execution ID to the QEP run. The adapter APIs expose case durations in memory. The v1 files contain the three contract fields per case and exclude raw diagnostics, names, paths and attachments. [DGI evidence details](infra-04.3.2-dgi-allure-adapter.md) · [CLU implementation](../src/clu-junit.ts)

The `--clu-junit` flag enables the opt-in reporter for the reviewed `clu-unit` revision. QEP prepares a fresh report directory and sets `QEP_REPORTING=1` inside the test child. When cleanup verifies, the runner seals the XML and Summary v0 bytes before publishing the summary. A successful child with a missing or unsealable report can leave a `PASS` Summary v0 while the run CLI exits 2. Collection requires the receipt. [CLU reporter merge](https://github.com/Shaobangzhu/react-clu-component-lib/pull/17) · [QEP runner](../src/runner.ts)

```sh
node dist/cli.js results collect --run-id "$QEP_RUN_ID"
node dist/cli.js results verify --run-id "$QEP_RUN_ID"
```

`collect` publishes `results-v1/result-v1.json` and `results-v1/manifest-v1.json` together. An identical retry reuses the saved files. `verify` reads the original evidence, validates the pair and compares both files with a fresh normalization. Both print the manifest and exit 0 when verification succeeds, including supported unsuccessful runs. Read `executionStatus`, `childExitCode` and `collectionState` for the suite outcome. Rejected evidence yields exit 2, empty stdout and a fixed diagnostic on stderr. `adapt-dgi --run-id <uuid>` also supports read-only normalization to stdout. [Collection implementation](../src/results.ts)

The local manifest binds bytes to run metadata. The source evidence and CLU receipt depend on the trusted local QEP run reservation and reviewed checkout. Keep the QEP baseline and detached workspace Git provenance with the acceptance record. [Owner evidence checklist](acceptance-04.3.md#f-hash-and-provenance-checks)
