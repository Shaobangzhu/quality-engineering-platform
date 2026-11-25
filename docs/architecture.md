# Architecture

QEP is a local Node.js and TypeScript CLI. Its catalog maps suite IDs to source package identities, fixed npm arguments and workload requirements.

| Suite | Source package identity | Catalog command |
| --- | --- | --- |
| `dgi-backend-unit` | `delivery-geo-intelligence` | `npm run test:backend:unit` |
| `dgi-frontend-unit` | `delivery-geo-intelligence` | `npm run test:frontend` |
| `clu-unit` | `@shaobangzhu/clu-ui` | `npm test` |

1. `plan` and default `run` check the source repository root, full HEAD SHA, clean index and working tree, package name, script and runtime compatibility. The plan exposes the executable and arguments separately and uses a run ID placeholder for local paths. Script and install eligibility are checked during execution.
2. `workspace` validates the pinned tree and provisions `.local/runs/<runId>/workspace/` from an exact, depth-one local Git transfer. QEP uses a detached HEAD, removes the workspace remote and rechecks provenance and source state.
3. `run --execute` acquires a lock for the QEP installation and provisions a new checkout. It checks the suite script, optionally installs dependencies and rechecks the snapshot before spawning the catalog command. The Linux runner uses a process group for cancellation, timeouts and descendant cleanup.
4. Reserved executions write `summary.json` beside the workspace. Run Summary v0 reports suite, package identity, SHA, runtime, timing, terminal phase, status, child exit code and failure category. Output is consumed in memory. A pass requires a zero child exit and positive aggregate evidence from Node TAP, Jest, Vitest or the audited DGI backend's Node spec reporter.
5. After execution, `adapt-dgi --run-id` verifies the selected DGI run's summary, manifest, audited records and optional JUnit counts. It prints a single [Contract v1](result-contract-v1.md) result.

The QEP workflow runs QEP's build, typecheck, lint and standard tests on Ubuntu. The DGI and CLU catalog entries are implemented. The 04.2 acceptance covers the three pinned real-source unit suites. [Acceptance report](acceptance-04.2.md)

Fresh real-source verification of the DGI adapter belongs to 04.3.5. Centralized Allure 3 reports and cross-repository candidate testing are separate milestones.
