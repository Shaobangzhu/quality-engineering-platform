# INFRA-04.6.3 sequential consumer gate

The consumer gate evaluates a CLU tarball against the published CLU dependency in the same reviewed DGI revision. Run from a QEP development install on Linux with the QEP-supported Node and npm runtime.

```sh
qe consumer plan \
  --clu-source "$CLU_SOURCE" --clu-sha "$CLU_SHA" \
  --dgi-source "$DGI_SOURCE" --dgi-sha "$DGI_SHA"

qe consumer run --execute --install-deps \
  --clu-source "$CLU_SOURCE" --clu-sha "$CLU_SHA" \
  --dgi-source "$DGI_SOURCE" --dgi-sha "$DGI_SHA"
```

Both selectors require absolute paths to clean local checkouts, full 40-character HEAD commit IDs, and the approved GitHub origin for the respective project. The DGI SHA must match the reviewed DGI frontend profile in the QEP suite catalog. Review the selected CLU commit, including its test, build and dependency inputs, before execution.

`consumer plan` and `consumer run` without execution options validate the sources and reviewed script forms and print the proposed sequence as JSON. They create no workspaces or evidence and launch no npm processes. Execution requires both flags because each fresh snapshot needs a lockfile install. An optional `--timeout-ms` on execution accepts an integer from 1 through 1800000 and defaults to 300000 per supervised process. Synchronous Git inspections have a separate 30-second limit per command.

## Execution and evidence

1. CLU installs the locked development dependencies with lifecycle hooks disabled. The reviewed unit suite must exit zero and produce positive test evidence. The gate then runs the reviewed build, checks the distribution files, and verifies the exact npm tarball and packing metadata.
2. DGI baseline installs from the original lockfile and verifies the published CLU resolution. It runs the three frontend commands below in order.
3. DGI candidate starts from an independent detached checkout at the same DGI SHA. QEP generates the reviewed candidate lockfile delta from the baseline. The only changes are the frontend CLU spec, its lockfile spec and package record, and the addition of the exact CLU tarball. The gate verifies npm's installed lock entry, the installed byte inventory, the Node and TypeScript export paths, and the shared physical React installation. It then runs the same frontend commands.
4. QEP verifies the lockfile bytes and installed dependency integrity and produces one comparison.

```sh
npm run typecheck -w frontend
npm run build -w frontend -- --mode quality
npm run test:frontend
```

The quality build uses `NODE_ENV=production`. Installs use the npm registry and each stage has a private home, npm cache and temp directory. The fixed workflow excludes root fullstack builds, backend test commands, database operations and E2E tests. A private evaluation lock rejects a second consumer execution within the same QEP installation. SIGINT and SIGTERM propagate to the active process group. Execution also stops on timeout or unsafe process cleanup. An unsafe cleanup retains the lock and scratch directory for inspection.

Once execution reserves an evaluation ID, its JSON summary and any verified CLU tarball are stored under `.local/consumer-gate/<evaluation-id>/`. Completed execution releases the scratch workspaces and caches after process cleanup. Each summary records both source SHAs, npm and Node versions, each step's status and process exit, verified dependency provenance, and the audited frontend counts and case-status digest when available. The CLI prints the JSON and summary path to stdout for success and stderr for failure. Selector, authorization and lock errors may occur before a summary is allocated. Consumer evidence uses its own schema and storage.

## Comparison and exit codes

- **PASS** requires successful typecheck, build and test commands in both DGI stages, verified dependency provenance, positive audited test results and matching counts and case statuses. The console's passed count must agree with the audited result files. QEP hashes the sorted case IDs and statuses so equal counts with substituted cases still fail the comparison.
- **REGRESSION** requires a passing baseline and a candidate frontend command failure or a mismatch in verified test results. Regular frontend failures allow the remaining frontend checks to finish for evidence.
- **BASELINE_FAILED** identifies a failed baseline even if the candidate also fails. The summary retains each stage's outcomes.
- **PRODUCER_FAILED** stops evaluation before DGI. **BLOCKED** covers policy, integrity or startup failures and a candidate that exits zero with missing or contradictory test evidence. An install failure stops downstream checks. A timeout or cancellation stops subsequent commands and reports **TIMEOUT** or **CANCELLED**.

The CLI returns 0 for PASS, the first actual nonzero child exit for ordinary failures, 1 for a comparison or test-evidence failure with no nonzero child exit, and 2 for policy, integrity, startup or cleanup failures with no nonzero child exit. A child signal exit is recorded with its signal-derived CLI code. Timeout returns 124, SIGINT returns 130, and SIGTERM returns 143. Unsafe process cleanup takes precedence so the operator can identify the retained lock.

## Validation scope

Offline fixtures use real npm with synthetic, cached packages and Git checkouts. They exercise the CLI from approval to retained evidence, including both-pass, producer and candidate failures, both DGI suites failing, typecheck and build failures, missing and contradictory evidence, count and case changes, an installed lock mismatch, unapproved commands, timeout, cancellation and concurrent execution rejection.

The real CLU and DGI evaluation remains unverified. Compatibility evidence covers frontend typecheck, build exits and audited unit test results. The DGI profile and lockfile policy are revision-sensitive. The local origin check and snapshots rely on trust in the operator's Git and npm runtimes and in the reviewed source contents. [Security boundaries](security-boundaries.md)
