# Runbook

## Validate QEP on Ubuntu

In a normal Ubuntu Remote-SSH terminal, use Git with `clone --revision` support and run:

```sh
cd /home/clu/projects/quality-engineering-platform
nvm install
nvm use
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run lint
npm test
git diff --check
```

The Codex sandbox can deny Git subprocess creation in Node fixtures with `spawnSync git EPERM`. A successful standard test run in a normal Ubuntu terminal or GitHub Actions can verify the supported-environment test gate. Hosted QEP CI must pass before merge.

## Plan, provision and execute

Use a local, ordinary SHA-1 Git checkout with an absolute canonical path and a clean index and working tree. Validate the source identity and HEAD against the independently approved baseline. Stop if either differs. Git must also support `--no-lazy-fetch`. Stale index stat metadata can trigger a rejection even when Git reports a clean tree.

Set `SUITE` to a catalog ID, `SOURCE_PATH` to the approved checkout's absolute path and `SOURCE_SHA` to its full 40-character SHA.

```sh
node dist/cli.js plan --suite "$SUITE" --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
node dist/cli.js workspace --suite "$SUITE" --source "$SOURCE_PATH" --sha "$SOURCE_SHA" --json
node dist/cli.js run --suite "$SUITE" --source "$SOURCE_PATH" --sha "$SOURCE_SHA" \
  --execute --install-deps --json
```

`workspace` is an optional inspection step. Each `run --execute` creates its own snapshot. Omit `--install-deps` for a dependency-free, direct Node suite. The installation and test phases each default to a 300,000 ms timeout. Override with `--timeout-ms` from 1 to 1,800,000.

Real-source smoke tests are deferred for v0.1 acceptance. For future smoke attempts, use the approved SHAs in the [report](acceptance-04.2.md) and run one suite at a time.

If QEP blocks an attempt, record the phase and reason and stop that attempt. Keep the approved command, checkout policy and install restrictions in effect. A failure before reservation has no workspace, run ID or summary.

## Read results and recover

Read `.local/runs/<runId>/summary.json` for a reserved execution. With `--json`, QEP also prints the summary on stdout for success and stderr for other terminal states. Record the CLI exit status separately from the child exit code. A null child exit code can mean no child started or a signal ended it. Missing test evidence after exit 0 is a failure. Ordinary child failures propagate their nonzero code. Timeout exits 124, SIGINT cancellation exits 130 and SIGTERM cancellation exits 143.

When an execution appears stuck, send SIGINT or SIGTERM to QEP and allow its cleanup to finish. If `.local/runs/execution.lock` remains, verify the prior QEP process and test descendants have stopped before removing the stale lock. Retain only sanitized evidence for review. Workspaces and local summaries are Git-ignored.
