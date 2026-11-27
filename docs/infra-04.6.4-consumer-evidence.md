# INFRA-04.6.4 consumer gate evidence

The consumer gate issues one `ConsumerGateV1` record per evaluation of the CLU candidate and the reviewed DGI frontend revision. The baseline uses DGI's published CLU dependency. The candidate uses the verified tarball produced from the selected CLU commit. [Execution commands](infra-04.6.3-consumer-gate.md)

## Record and manifest

| File or field | Contract |
| --- | --- |
| `consumer-gate-v1.json` | `schemaVersion: 1`, UUIDv4 `evaluationId`, UTC start and end timestamps, per-process timeout, and Node, npm and QEP package versions. |
| `commits` | Exact 40-character lowercase CLU and DGI Git SHAs. The manifest repeats both. Each phase records its observed detached checkout SHA when the checkout check succeeds. The archive receipt repeats the CLU producer SHA. |
| `archive` and `candidate.tgz` | Verified CLU package name and version, producer SHA, npm version, byte size, lowercase SHA-256 and SHA-512 in npm SRI form, plus the fixed producer commands. Both are present once packing and archive validation succeed. |
| `locks`, `dgi-original-lock.json` and `dgi-patched-lock.json` | SHA-256 and exact bytes of both root lockfiles once the candidate lock plan succeeds. Verification reconstructs the patched bytes from the original lockfile and verified archive. |
| `phases` | CLU, baseline and candidate results. Each contains the ordered checks actually attempted, the child exit or `null`, the step CLI code and an enumerated failure category. A successful local check has `null` child exit. Test evidence includes the observed positive console count when available. Audited DGI test evidence contains aggregate counts and sorted, hashed case IDs with statuses. |
| DGI package observations | The baseline records the published CLU resolution confirmed in npm's installed lock. The candidate records the resolved ESM, declaration, CSS and shared React paths when checked. Its final installed package observation records the installed lock identity and the SHA-256 of sorted `[relative path, file SHA-256]` pairs encoded as compact JSON. |
| `interruption` and `decision` | Late cancellation or unsafe cleanup, the derived overall status, a fixed reason and the actual consumer run exit code. |
| `manifest-v1.json` | `ManifestV1` with `schemaVersion: 1`, UUID and commits. Each ordered entry has a fixed filename, byte length and SHA-256 of the exact file bytes. The inventory includes the record, the run summary and any verified archive or lockfile artifacts. The manifest is published last and its SHA-256 is printed by `consumer run`. |

The versioned record, manifest and artifacts live in the owner-only QEP runtime directory `.local/consumer-gate/<evaluation-id>/`. A new run allocates a fresh ID and exclusively creates each evidence file. The verifier bounds the manifest to 4 KiB, the record to 4 MiB and each DGI phase to 10,000 audited cases. The summary, archive and each lockfile have respective limits of 256 KiB, 8 MiB and 16 MiB. JSON schemas enforce field names, section presence, order of attempted checks and consistent statuses. The record includes sanitized categories and hashed case identities. Scratch storage is removed after safe cleanup and may be retained for inspection after unsafe cleanup. Consumer runs stay in the consumer gate workflow. The accepted-run importer and report commands select accepted runs through their existing storage.

## Decision rules

- **PASS** requires a passing producer, a passing baseline and a passing candidate. Each frontend phase requires successful commands, verified installation, positive audited results, and agreement between its audited and console counts. The two frontend phases must have identical case IDs and statuses.
- **FAIL** means `candidate-compatibility-regression`. It requires a passing baseline and verified candidate dependency integrity. A candidate frontend command exited nonzero, or two otherwise passing frontend phases had different audited cases or statuses.
- **BLOCKED** covers a failed or blocked producer or baseline, missing or contradictory evidence, integrity and policy failures, and interruptions. A skipped phase has status `BLOCKED` and an empty step list. A baseline with an ordinary frontend command failure has phase status `FAIL` and yields an overall `BLOCKED`.

## Independent verification

```sh
qe consumer verify --evaluation-id "$EVALUATION_ID" --json
qe consumer verify --evaluation-id "$EVALUATION_ID" --json \
  --clu-sha "$CLU_SHA" --dgi-sha "$DGI_SHA" --manifest-sha256 "$TRUSTED_MANIFEST_SHA256"
```

Verification opens the fixed files under the selected UUID read-only. It checks inventory, lengths and hashes, validates the DGI revision against the reviewed revisions, and checks the commits across the manifest, record, observed checkouts, run summary and producer receipt. It rescans the archive structure and package contract, recomputes the archive hashes and member inventory, replays the lockfile change, recomputes the frontend counts and case digests, derives the phase statuses and decision, and checks the run summary against the record. Verification requires only the retained evidence and the QEP installation on Linux. A successful verifier exits 0 and emits `verified: true`, the manifest digest and the validated record, including evaluations whose gate decision was `FAIL` or `BLOCKED`. Invalid arguments or evidence exit 2. With `--json`, the error is a JSON object with `verified: false` and a fixed reason on stderr. Pre-seal historical summaries remain available at their original paths and are outside the versioned verification contract.

The SHA-256 manifest supplies internal integrity. To authenticate a specific issuance, keep the digest printed at execution in a separately trusted location and supply `--manifest-sha256`. Supply the expected commits when they are known independently. Historical child exits, test results and installed-file observations rely on the QEP runtime that issued the record. Keep previously reviewed DGI revisions in the verification catalog when advancing the execution profile.

## Fixture coverage

The offline fixtures run real npm against cached synthetic packages and temporary Git checkouts.

| Fixture | Baseline | Candidate | Decision | Run exit |
| --- | --- | --- | --- | ---: |
| Compatible package with one passing test in each phase | PASS | PASS | PASS | 0 |
| Candidate's `Button()` produces a different element than the DGI test expects | PASS | FAIL | FAIL | 37 |
| Baseline installed lock digest differs from its published CLU entry | BLOCKED | BLOCKED (skipped) | BLOCKED | 2 |
| Candidate's audited test artifacts are missing | PASS | BLOCKED | BLOCKED | 1 |
| Candidate's installed package bytes differ from the archive | PASS | BLOCKED | BLOCKED | 2 |

Each of these fixtures emits a record that verifies with exit 0. Verification tests reject a changed archive, a rehashed invalid lockfile or contradictory summary, wrong commits, missing test counts, false passing statuses, a copied evaluation under a different UUID, missing files and malformed manifests. A UUID collision preserves the original sealed evaluation. The read-only fixture removes both source paths, holds the execution lock, and compares the evidence tree and npm invocation log before and after verification.
