# 04.6 ACCEPTANCE PREPARATION REPORT

Prepared on 2026-11-27 UTC from `test/infra-04.6.5-acceptance` at `504b948f1eae7e6324205eeffb6724a2a7ceb816`.

| Status | Disposition |
| --- | --- |
| Synthetic validation PASS | QEP build, typecheck, lint, 250 standard tests and 45 dedicated consumer fixtures passed. |
| Real-source integration pending | Both original checkouts match the requested commits. The combined plan stopped on existing ignored `dist/` in CLU. The owner must plan from a clean copy at the approved SHA and explicitly authorize execution. |
| Real-source integration verified | Pending a sealed owner evaluation with run exit `0`, verified evidence, a `PASS` decision and source and hosting integrity checks. |

## A. Implementation

GitHub confirms all four PRs merged into `main`. All four merge commits are in the first-parent history of the reviewed QEP checkout and its recorded `origin/main` tip.

| Milestone | Implementation | Merge |
| --- | --- | --- |
| 04.6.1 | Pin, build and verify a private CLU tarball | `5fc20a0` [PR #25](https://github.com/Shaobangzhu/quality-engineering-platform/pull/25) |
| 04.6.2 | Prepare isolated DGI checkouts and verify candidate injection | `7218e0a` [PR #26](https://github.com/Shaobangzhu/quality-engineering-platform/pull/26) |
| 04.6.3 | Run the sequential producer and consumer phases | `9d335ed` [PR #27](https://github.com/Shaobangzhu/quality-engineering-platform/pull/27) |
| 04.6.4 | Seal and independently verify comparison evidence | `504b948` [PR #28](https://github.com/Shaobangzhu/quality-engineering-platform/pull/28) |

The accepted 04.5 merge `76250077f8840fdf416d30c408abda2b8ccfde22` is an ancestor. The tracked hosting configuration and 04.5 acceptance record match that merge. Section G records the independent checks of the accepted report and deployment. [04.5 final acceptance](acceptance-04.5.md)

## B. Synthetic tests

Node `v22.23.4`, npm `10.9.9` and Git `2.53.0` were used.

| Command | Result |
| --- | --- |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS, 250 of 250 |
| `node --test test/clu-candidate.test.js test/dgi-candidate.test.js test/consumer.test.js` | PASS, 45 of 45 |
| `git diff --check` | PASS |

The first sandboxed test attempts failed at fixture process startup. The reruns passed with normal subprocess access and used temporary synthetic Git repositories and cached npm packages. The hosted workflow now names the three consumer fixture files in a dedicated step. Hosted execution of this workflow change is pending. [QEP CI](../.github/workflows/ci.yml)

Negative paths verified rejection of wrong or dirty selectors, unapproved scripts, incompatible or duplicate React, a wrong installed lock identity, modified installed package bytes, export resolution failure, missing or contradictory evidence and evidence tampering. Fixture failures preserved exit `17` for the producer, `37` for a candidate test regression, `23` for the first failure when both DGI suites failed, and `19` for candidate typecheck failure while capturing the subsequent build exit `27`. The suite verified timeout exit `124`, cancellation exit `143`, process-group cleanup and concurrent execution rejection. [Runner behavior](infra-04.6.3-consumer-gate.md) · [Fixture coverage](infra-04.6.4-consumer-evidence.md#fixture-coverage)

## C. Real source readiness

Both originals met QEP's read-only source tree, exact commit and origin checks. Their branches were observed during review. Source selection uses the full SHAs.

| Original checkout | Observed branch | Verified HEAD |
| --- | --- | --- |
| `/home/clu/projects/delivery-geo-intelligence` | `main` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` |
| `/home/clu/projects/react-clu-component-lib` | `master` | `8bda12f627e6234ed122fef29b48bd5ee2e2706d` |

`qe consumer plan` with those original paths exited `2` with `Candidate checkout contains pre-existing build output.` CLU's `dist/` is ignored by Git and is present on disk. The checkout was preserved. DGI's standalone frontend plan passed. The owner procedure checks both originals, prepares a fresh CLU copy at the reviewed SHA and verifies the combined plan before executing. [Ubuntu owner commands](consumer-gate-runbook.md#plan-verify-authorize-and-run)

## D. Candidate provenance

The initial CLU commit declares `@shaobangzhu/clu-ui` version `0.1.0-rc.2` and a React peer of `^19.0.0`. The owner selects the actual reviewed candidate SHA, which may differ from the initial example. The gate binds the built tarball to the producer checkout SHA, package version, byte size, SHA-256 and SHA-512 SRI. It verifies the installed lock identity and member inventory before and after the frontend checks. It also verifies ESM, declaration and CSS resolution and checks that DGI and CLU share the compatible physical React installation. Synthetic verification passed. The real tarball, digests and installed observations await owner execution. [Package and consumer stages](consumer-gate-architecture.md)

## E. Baseline/candidate comparison

DGI's checked-in lockfile selects the published `@shaobangzhu/clu-ui` version `0.1.0-rc.2` from the npm registry and React `19.3.0`. Its locked React version satisfies the initial candidate's React peer range. Even for equal package versions, the candidate must install the exact archive from the CLU stage. The synthetic comparison passed and rejected candidate-only failures, count changes and equal counts with substituted cases. Current real baseline and candidate typecheck, quality build, unit results and case comparison remain pending. The 04.5 report counts describe its accepted historical run selection.

## F. Evidence integrity

Synthetic records verified with the expected UUID, both commits and issuance manifest SHA-256. The verifier checked file bytes, archive identity, lockfile replay, installed observations and the derived decision. The fixtures rejected tampering, inconsistent resealed artifacts and conflicting identities. A verified record can report `PASS`, `FAIL` or `BLOCKED`. Full acceptance requires a real `PASS` record and matching run exit `0`. There is no real evaluation UUID or issuance digest for this review. [ConsumerGateV1 and ManifestV1](infra-04.6.4-consumer-evidence.md)

## G. Source and hosting integrity

The original source branches, HEADs, clean Git status and staged index entries matched the preparation snapshots. The before and after inventories also matched across private runs, reports, promotion receipts and the deployed tree, including file hashes, modes and symlink targets. The private report verified at ID `4a01f5da12c7404e80d4b1317eb312685e16f9cc85387f665d29828e264df6ee` with 529 passing cases, one accepted launch and `previousReportId: null`. All five private report files, including `history.jsonl`, matched the retained 04.4 checksums. `qe site verify` confirmed the accepted active release and its 3,104,756-byte HTML. Before and after testing, the live Nginx `/` and `/index.html` responses matched the accepted SHA-256 `d54c2d237e6c121e364729ea1b941bdfe8e6d1a394e76c8a474c0706ae630ad6`. [04.5 report and deployment evidence](acceptance-04.5.md#b-private-report-provenance)

## H. Deferred scope

Owner approval of the selected CLU SHA, the clean-copy combined plan, real execution, independent evidence verification and the owner source and hosting recheck are pending. Hosted CI evidence for the new step is also pending. The compatibility decision covers the DGI frontend checks. Backend, database and E2E checks fall outside that comparison.

## I. GO / NO-GO

**GO** for the QEP-only acceptance preparation and an owner replan using a clean CLU checkout at the actual approved SHA. **NO-GO** for execution against the original CLU path with existing build output and for Full Acceptance at this point. Record Real-source integration verified after the owner confirms the approved plan, obtains a verified `PASS` with matching audited baseline and candidate results, and checks the protection evidence. [Owner runbook](consumer-gate-runbook.md)
