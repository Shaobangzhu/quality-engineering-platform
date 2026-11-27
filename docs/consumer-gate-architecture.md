# CLU-to-DGI consumer gate architecture

`qe consumer` compares a package built from an explicitly selected CLU commit with the published CLU package locked by a reviewed DGI frontend revision. Both frontend phases use the same DGI commit, runtime and check sequence. The lockfile policy isolates the CLU dependency change so the gate can attribute a candidate-only failure to that change within this test scope.

| Stage | Controls and evidence |
| --- | --- |
| Plan | Validate the canonical local source paths, exact HEAD commits, clean Git state, approved origins and reviewed scripts. Check DGI against the consumer profile and reject a CLU input with existing `dist/` output. Print the paths, commits, commands and required execution flags. |
| CLU producer | Create a private detached checkout with its own home, cache and temp directory. Install locked dependencies with hooks disabled, require a passing unit run with positive test evidence, build the distribution, and pack it with lifecycle hooks disabled. Verify the package identity, archive inventory, ESM, declarations, stylesheet and external React peer. Record the producer SHA, package version, byte size and archive digests. |
| DGI baseline | Create a separate detached checkout and install from the original root lockfile. Verify the published CLU resolution in npm's installed lock, then run frontend typecheck, the production-environment quality build, and the audited frontend unit suite. |
| DGI candidate | Create a third detached checkout. Add the verified tarball and patch the frontend CLU spec and its two corresponding root lockfile records. Verify npm's installed `file:` resolution, SHA-512 SRI and exact installed member bytes. Resolve the package's ESM, TypeScript declarations and stylesheet. Require a single locked React version that satisfies both DGI and the CLU peer, and the same physical React installation for the frontend, CLU and React DOM when installed. Run the same frontend checks and recheck the dependency files and installation after execution. |
| Compare and seal | Require all three phases to pass, positive audited DGI counts that agree with the console counts, and identical case IDs and statuses in both DGI phases. Seal the private `ConsumerGateV1` record and retained artifacts under the evaluation UUID. Publish the manifest last. |

The gate requires `--execute` and `--install-deps` together. Each install uses `npm ci --ignore-scripts --include=dev` and a private npm cache. The Linux runner supervises process groups, rejects concurrent execution, and propagates child failures, timeouts and signals. Cleanup removes the scratch workspaces after safe termination. Unsafe cleanup retains the lock and scratch for inspection. The frontend comparison covers typecheck, quality build and unit checks. [Runner and exit-code details](infra-04.6.3-consumer-gate.md)

## Evidence and decisions

- `PASS` requires a passing producer and comparable passing baseline and candidate phases.
- `FAIL` marks a candidate compatibility regression after a passing baseline and verified candidate dependency integrity. An ordinary candidate command failure or a change in comparable audited cases can cause it.
- `BLOCKED` covers producer and baseline failures, missing or contradictory evidence, integrity failures and interrupted execution.

The evidence directory `.local/consumer-gate/<evaluation-id>/` holds the record, summary, and available verified archive and lockfiles. `ManifestV1` binds the evaluation ID and source SHAs to the exact stored bytes. The read-only verifier recomputes hashes, validates the archive, replays the lockfile delta and derives the decision from the saved observations. Verification exit `0` means the evidence verified. The record's decision determines the compatibility result. A separately retained issuance digest and the independently approved source commits bind verification to the owner's intended run. [Versioned evidence contract](infra-04.6.4-consumer-evidence.md)

The execution boundary relies on trusted reviewed source code and the owner host's Git, Node and npm runtimes. Gate evidence stays in private consumer storage. The existing accepted runs, Allure history and promoted Nginx release use their established report paths. Hosted QEP CI exercises packaging, injection, the sequential gate and verification with temporary Git repositories and cached synthetic npm packages. [Security boundaries](security-boundaries.md) · [Owner runbook](consumer-gate-runbook.md) · [Acceptance preparation](acceptance-04.6.md)
