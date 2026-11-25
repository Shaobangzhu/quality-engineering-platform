# QEP Test Result Contract v1

A result describes one execution of one catalog suite at one source commit. Its companion manifest binds that provenance to the exact result file. Both are UTF-8 JSON objects with numeric `schemaVersion` equal to `1`. The implementation and synthetic fixtures are in [result-contract-v1.ts](../src/result-contract-v1.ts) and [result-contract-v1.test.js](../test/result-contract-v1.test.js).

## Result fields

| Field | Accepted value |
| --- | --- |
| `schemaVersion` | Integer 1 |
| `runId` | Lowercase UUIDv4 with RFC variant, assigned by QEP |
| `suiteId` | `dgi-backend-unit`, `dgi-frontend-unit`, or `clu-unit` |
| `sourceCommit` | Full 40-character lowercase Git SHA from the verified checkout. The suite catalog identifies its repository. |
| `executionStatus` | `PASS`, `FAIL`, `BLOCKED`, `CANCELLED`, `TIMEOUT`, or `UNKNOWN` |
| `childExitCode` | Optional. An integer from 0 through 255, or null when unavailable |
| `collectionState` | `COMPLETE`, `PARTIAL`, or `INVALID` |
| `cases` | Array of up to 10,000 records. Each contains exactly `caseId`, `executionId`, and `status`. |
| `counts` | Required integers `total`, `passed`, `failed`, `broken`, `skipped`, and `unknown`. Each must equal the tally computed from the records, including zeroes. |

### Identity and provenance

The producer supplies a stable logical key for each test, such as a repository-relative test locator plus a qualified name and stable parameter identifier. The key must be nonempty, trimmed, and at most 512 UTF-8 bytes. Renaming a key changes its identity. Keep run IDs, commit SHAs, array positions, host paths, secrets and runtime parameter values out of logical keys.

`createCaseId` serializes the tuple `["qep-case-v1", suiteId, logicalKey]` with ECMAScript `JSON.stringify`, hashes its UTF-8 bytes with SHA-256, and joins the suite ID and lowercase hex digest with a colon. The case ID is at most 82 ASCII characters. For suite `clu-unit` and key `unit/example#0`, the ID is `clu-unit:2755f53e016f1458abb2071a52518b3488d2a2d1cf1783a64c6bf6689e1f6105`.

`createExecutionId` joins the run ID and complete case ID with a colon (119 characters maximum). The parser checks both namespaces, recomputes each execution ID, and rejects repeated cases. V1 represents each logical case once per run. Every record inherits its commit from the result header. Producers must establish evidence belongs to that checkout before constructing records. The contract cannot reconstruct source provenance from a case digest.

### Evidence and collection

A case status requires individual case evidence. An explicit pass maps to `passed`, an assertion failure to `failed`, a case execution error to `broken`, and an explicit skip to `skipped`. An observed case with an indeterminate outcome maps to `unknown`. The normalization helper accepts the canonical spellings and the semantic aliases `failure`, `error`, and `disabled`. Unrecognized values map to `unknown`. Only canonical spellings are valid on the wire. Absent cases contribute zero records.

| Collection state | Producer meaning and validation |
| --- | --- |
| `COMPLETE` | Producer confirms collection finished. Requires explicit execution PASS, child exit 0, at least one passed case, and all other cases passed or skipped. |
| `PARTIAL` | At least one usable record survived an incomplete collection or unsuccessful execution. All five case statuses are available. |
| `INVALID` | Zero usable records. The producer must know the run provenance even to publish this state. Malformed input itself fails validation. |

Execution PASS requires COMPLETE. Preserve known execution failures even when some cases passed. Use UNKNOWN when execution metadata is unavailable or a claimed success lacks sufficient case evidence. For example, an exit of zero with no records yields UNKNOWN, INVALID and six zero counts. A cancelled run with two verified passes yields CANCELLED, PARTIAL and two passes. Keep missing child exit metadata absent or null. Neither form satisfies the PASS rule. Completeness is a producer assertion subject to those checks. A consumer cannot detect an omitted case without an independent inventory.

## Integrity manifest

`ManifestV1` carries the same four header fields (`schemaVersion`, `runId`, `suiteId`, `sourceCommit`) and a `files` array with exactly one entry.

| Entry field | Required value |
| --- | --- |
| `name` | Literal basename `result-v1.json` |
| `bytes` | Exact result byte length, 1 through 4,194,304 |
| `sha256` | Lowercase 64-character hex digest of those exact bytes, including whitespace |

Pass the final result bytes to `createManifestV1`. It validates the result before producing the manifest. On consumption, pass the serialized manifest (1 through 1,024 bytes) and the named result bytes to `verifyManifestV1`. Verification validates both schemas, checks all four header fields, then checks the filename, size and digest. Reformatting a result requires a new manifest. Authenticating the manifest or the producer requires an independent trusted reference.

`qe results collect --run-id <uuid>` publishes the pair in `.local/runs/<uuid>/results-v1/`. `qe results verify --run-id <uuid>` checks the saved bytes against the manifest and regenerates the expected pair from the selected run's source evidence. A successful verification indicates evidence integrity. The suite outcome is `executionStatus` in the result. Summary v0 stays at `.local/runs/<uuid>/summary.json` and remains the runner's record of the execution. [Adapter evidence and CLI behavior](adapters.md) · [Owner acceptance procedure](acceptance-04.3.md)

## Security boundary

Use `parseResultV1` for external result bytes and `verifyManifestV1` for artifact pairs. TypeScript annotations alone provide no runtime validation. Bound each read at its file limit before allocating input buffers. The module performs no filesystem access. All stored strings have fixed vocabularies or identifier formats. Unknown fields, duplicate JSON members, malformed UTF-8, and unsupported versions fail validation. Errors contain fixed diagnostic labels.

The schema provides no free-text or attachments field. Logical keys stay on the producer side of the digest. Raw console output, assertion values, stack traces, credentials and host paths have no place in the artifact. Only trusted QEP run and checkout metadata should supply the header identifiers. The v1 module is independent of Summary v0, runner execution, framework adapters and report rendering.
