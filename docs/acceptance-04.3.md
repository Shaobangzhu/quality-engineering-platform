# INFRA-04.3 Acceptance Preparation Report

INFRA-04.3.5 preparation on 2026-11-25 UTC. Final acceptance is pending three fresh owner-run suites and independent evidence review.

## A. Contract implementation

| Stage | Verified merge commit | Pull request |
| --- | --- | --- |
| 04.3.1 Result Contract v1 | `87f1f83358f145510aa8f88445d39316bda9d3ae` | [QEP #10](https://github.com/Shaobangzhu/quality-engineering-platform/pull/10) |
| 04.3.2 DGI Allure adapter | `e796ec02326b631213961cb1ec5fb7ab8f75dfb6` | [QEP #11](https://github.com/Shaobangzhu/quality-engineering-platform/pull/11) |
| 04.3.3 CLU opt-in reporter | `8bda12f627e6234ed122fef29b48bd5ee2e2706d` | [CLU #17](https://github.com/Shaobangzhu/react-clu-component-lib/pull/17) |
| 04.3.4 CLU adapter and results CLI | `70019d6aeb166f72429668551621263e49d80fd1` | [QEP #12](https://github.com/Shaobangzhu/quality-engineering-platform/pull/12) |

GitHub returned `merged=true` for all four PRs. The QEP merges appear on the first-parent history of local `origin/main` and the acceptance branch. The CLU merge matches the local `origin/master` ref. All three working trees started clean.

| Checkout | Branch | HEAD |
| --- | --- | --- |
| QEP | `test/infra-04.3.5-acceptance` | `70019d6aeb166f72429668551621263e49d80fd1` |
| DGI | `main` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` |
| CLU | `master` | `8bda12f627e6234ed122fef29b48bd5ee2e2706d` |

Contract v1 validates run identity, case identity, status, counts and exact result bytes. Collection writes the v1 pair beside Summary v0 and verification derives the expected pair again from the selected run. [Result schema](result-contract-v1.md) · [Adapter evidence](adapters.md)

## B. Adapter coverage

All 31 focused tests passed, including 10 contract, 15 DGI and 6 CLU tests. The fixtures use temporary QEP installations and synthetic reports.

| Acceptance check | Verified behavior |
| --- | --- |
| Wrong SHA | QEP rejects a checkout at a different SHA. DGI and CLU fixtures reject unapproved summary provenance. DGI also rejects a manifest with the wrong commit. |
| Missing source evidence | Missing audited DGI files or CLU XML stops collection. CLU requires the receipt. |
| Case count mismatch | The contract rejects counts that disagree with records. Each adapter rejects inconsistent reporter totals. |
| Failed execution | Passing cases within a failed execution retain the failed execution status and partial collection. A PASS summary with unsuccessful cases is rejected. |
| Tampered result hashes | The manifest rejects changed bytes. The CLI also rejects an edited result with a regenerated digest when the pair differs from the original evidence. |
| Mixed run IDs | Foreign execution IDs, foreign result/manifest pairs and DGI records from another execution window are rejected. |
| Duplicate case identities | The parser and both adapters reject repeated logical cases. |
| Sanitized diagnostics | Fixture markers, host paths and raw failure output are excluded from normalized artifacts and verification diagnostics. |
| Summary v0 | Both adapters preserve the exact summary bytes through collection, verification and retry. |

## C. QEP regression results

Node `v22.23.4`, npm `10.9.9` and Git `2.53.0`. Build, typecheck, lint and `git diff --check` passed. The standard `npm test` passed 150 tests with zero failures or skips when permitted to spawn the synthetic Git subprocesses. In the restricted session, plan, runner and workspace fixture files failed, and the plan diagnostic showed `spawnSync git EPERM`.

The QEP-only workflow now runs an explicit Contract v1 and adapter fixture step as well as the standard tests. Hosted CI for the acceptance changes is pending. [QEP workflow](../.github/workflows/ci.yml)

## D. Real-source execution instructions

The owner runs this block in an ordinary Ubuntu Bash terminal using an existing Node `22.23.4`, npm `10.9.9` and Git with `clone --revision` support. With nvm already configured, run `nvm use` from the QEP directory first. The script verifies the checkout pins, runs read-only plans, and runs the three suites serially. It keeps a private evidence directory under QEP `.local/`. Dependency installation for each suite runs in its QEP workspace via `--install-deps`. The source checkouts must already be clean at the specified SHAs.

```bash
bash <<'BASH'
set -euo pipefail
umask 077
cd /home/clu/projects/quality-engineering-platform

qep_sha=70019d6aeb166f72429668551621263e49d80fd1
dgi=/home/clu/projects/delivery-geo-intelligence
clu=/home/clu/projects/react-clu-component-lib
dgi_sha=2ef00a81e55e7d150770bfc81abffd96dffdc0b3
clu_sha=8bda12f627e6234ed122fef29b48bd5ee2e2706d

[[ $(git branch --show-current) == test/infra-04.3.5-acceptance && $(git rev-parse HEAD) == "$qep_sha" ]] || {
  printf 'Use the specified QEP acceptance branch and SHA.\n' >&2
  exit 1
}
git_help=$(LC_ALL=C git clone -h 2>&1 || true)
[[ $(node --version) == v22.23.4 && $(npm --version) == 10.9.9 &&
   $(uname -s) == Linux && -d /proc/self/fd &&
   ( $git_help == *--revision* || $git_help == *'--[no-]revision'* ) ]] || {
  printf 'Use the specified Ubuntu, Node and npm environment and Git with clone --revision.\n' >&2
  exit 1
}

source_snapshot() {
  local repo=$1 branch sha status
  branch=$(git --no-optional-locks -C "$repo" symbolic-ref --short HEAD) || return
  sha=$(git --no-optional-locks -C "$repo" rev-parse HEAD) || return
  status=$(git --no-optional-locks -c core.fsmonitor=false -C "$repo" \
    status --porcelain=v1 --untracked-files=all) || return
  printf 'branch=%s\nhead=%s\nstatus=%s\n' "$branch" "$sha" "$status"
  sha256sum "$repo/.git/index" || return
  [[ $branch == "$2" && $sha == "$3" && -z $status ]]
}

mkdir -p -m 700 .local
evidence=$(mktemp -d "$PWD/.local/acceptance-04.3.5.XXXXXX")
printf 'Acceptance evidence directory %s\n' "$evidence"
source_snapshot "$dgi" main "$dgi_sha" > "$evidence/dgi.before"
source_snapshot "$clu" master "$clu_sha" > "$evidence/clu.before"
shopt -s nullglob
historical=(.local/runs/*/summary.json)
if ((${#historical[@]})); then sha256sum "${historical[@]}" > "$evidence/prior-summaries.sha256"; fi

check_after() {
  local status=$?
  source_snapshot "$dgi" main "$dgi_sha" > "$evidence/dgi.after" || status=1
  source_snapshot "$clu" master "$clu_sha" > "$evidence/clu.after" || status=1
  diff -u "$evidence/dgi.before" "$evidence/dgi.after" || status=1
  diff -u "$evidence/clu.before" "$evidence/clu.after" || status=1
  if [[ -s $evidence/prior-summaries.sha256 ]]; then
    sha256sum --check --quiet "$evidence/prior-summaries.sha256" || status=1
  fi
  exit "$status"
}
trap check_after EXIT

[[ ! -e .local/runs/execution.lock && ! -L .local/runs/execution.lock ]]
printf 'qep_commit=%s\n' "$qep_sha" > "$evidence/runtime.txt"
{ node --version; npm --version; git --version; date -u +%FT%TZ; } >> "$evidence/runtime.txt"
: > "$evidence/npmrc"
npm ci --ignore-scripts --no-audit --no-fund --userconfig "$evidence/npmrc" \
  --globalconfig /dev/null --cache "$evidence/npm-cache"
npm run build
node dist/cli.js plan --suite dgi-backend-unit --source "$dgi" --sha "$dgi_sha" --json > "$evidence/dgi-backend-unit.plan.json"
node dist/cli.js plan --suite dgi-frontend-unit --source "$dgi" --sha "$dgi_sha" --json > "$evidence/dgi-frontend-unit.plan.json"
node dist/cli.js plan --suite clu-unit --source "$clu" --sha "$clu_sha" --json > "$evidence/clu-unit.plan.json"

run_suite() {
  local suite=$1 source=$2 sha=$3 attempt run_id run_dir workspace cli_exit=0
  shift 3
  attempt=$evidence/$suite
  mkdir "$attempt" || return
  node dist/cli.js run --suite "$suite" --source "$source" --sha "$sha" \
    --execute --install-deps --json "$@" \
    > "$attempt/runner.stdout" 2> "$attempt/runner.stderr" || cli_exit=$?
  printf 'runner_cli_exit=%s\n' "$cli_exit" | tee "$attempt/exit.txt"
  run_id=$(node --input-type=module - "$attempt" <<'NODE'
import {readFileSync} from 'node:fs';
const dir = process.argv[2];
const output = ['stdout', 'stderr'].map(stream => readFileSync(`${dir}/runner.${stream}`, 'utf8').trim());
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
for (const text of output) {
  let id;
  try { id = JSON.parse(text).runId; }
  catch { id = /^Unable to seal CLU JUnit for run ([0-9a-f-]+)\.$/.exec(text)?.[1]; }
  if (idPattern.test(id ?? '')) { console.log(id); process.exit(0); }
}
console.error('No reserved run UUID was reported. Review the local runner output.');
process.exitCode = 1;
NODE
  ) || return
  printf 'run_id=%s\n' "$run_id" | tee -a "$attempt/exit.txt"
  run_dir=$PWD/.local/runs/$run_id
  workspace=$run_dir/workspace
  (cd "$run_dir" && sha256sum summary.json) > "$attempt/summary.sha256" || return
  node dist/cli.js results collect --run-id "$run_id" > "$attempt/collect.json" || return
  (cd "$run_dir" && sha256sum results-v1/{result-v1,manifest-v1}.json) > "$attempt/results.sha256" || return
  node dist/cli.js results collect --run-id "$run_id" > "$attempt/retry.json" || return
  node dist/cli.js results verify --run-id "$run_id" > "$attempt/verify.json" || return
  cmp "$attempt/collect.json" "$attempt/retry.json" || return
  cmp "$attempt/collect.json" "$attempt/verify.json" || return
  (cd "$run_dir" && sha256sum --check "$attempt/summary.sha256" "$attempt/results.sha256") || return

  local workspace_sha workspace_ref workspace_remotes
  workspace_sha=$(git --no-optional-locks -C "$workspace" rev-parse HEAD) || return
  workspace_ref=$(git --no-optional-locks -C "$workspace" rev-parse --symbolic-full-name HEAD) || return
  workspace_remotes=$(git --no-optional-locks -C "$workspace" remote) || return
  printf 'head=%s\nref=%s\nremotes=%s\n' "$workspace_sha" "$workspace_ref" "$workspace_remotes" > "$attempt/workspace.txt"
  [[ $workspace_sha == "$sha" && $workspace_ref == HEAD && -z $workspace_remotes ]] || return 1

  node --input-type=module - "$run_dir" "$run_id" "$suite" "$sha" "$cli_exit" <<'NODE' | tee "$attempt/outcome.json"
import {readFileSync} from 'node:fs';
import {verifyManifestV1} from './dist/result-contract-v1.js';
const [dir, runId, suiteId, sourceCommit, cliExit] = process.argv.slice(2);
const read = name => readFileSync(`${dir}/${name}`);
const bytes = read('results-v1/result-v1.json');
const manifest = verifyManifestV1(read('results-v1/manifest-v1.json'), bytes);
const result = JSON.parse(bytes);
const summary = JSON.parse(read('summary.json'));
console.log(JSON.stringify({cliExit: Number(cliExit), summary,
  executionStatus: result.executionStatus, childExitCode: result.childExitCode,
  collectionState: result.collectionState, counts: result.counts, resultSha256: manifest.files[0].sha256}, null, 2));
if (cliExit !== '0' || summary.runId !== runId || summary.suiteId !== suiteId || summary.commitSha !== sourceCommit ||
    summary.phase !== 'test' || summary.status !== 'PASS' || summary.exitCode !== 0 ||
    result.runId !== runId || result.suiteId !== suiteId || result.sourceCommit !== sourceCommit ||
    result.executionStatus !== 'PASS' || result.childExitCode !== 0 || result.collectionState !== 'COMPLETE') {
  process.exitCode = 1;
}
NODE
}

overall=0
run_suite dgi-backend-unit "$dgi" "$dgi_sha" || overall=1
run_suite dgi-frontend-unit "$dgi" "$dgi_sha" || overall=1
run_suite clu-unit "$clu" "$clu_sha" --clu-junit || overall=1
exit "$overall"
BASH
```

Provide the three new run UUIDs and the acceptance evidence directory path on the shared host. Keep the original private run directories available for independent review. The local `exit.txt`, `outcome.json`, `workspace.txt`, SHA-256 lists and source snapshots record the information needed to review each attempt. An absent `outcome.json` means the workflow stopped before it verified a pair. Keep that attempt's record for diagnosis. If an execution lock remains, follow the runbook procedure. [Runbook](runbook.md#read-results-and-recover)

## E. Per-run evidence status

| Suite | Fresh run UUID | Summary v0 and v1 files | Status |
| --- | --- | --- | --- |
| `dgi-backend-unit` | Pending | Pending | Awaiting owner evidence |
| `dgi-frontend-unit` | Pending | Pending | Awaiting owner evidence |
| `clu-unit` | Pending | Pending | Awaiting owner evidence |

Read-only replay of the historical 04.2 DGI backend and frontend evidence returned 189 and 257 passing cases respectively and reproduced the 04.3.2 result hashes. Those runs predate 04.3.5. The 04.2 CLU run predates the opt-in JUnit reporter. [DGI historical review](infra-04.3.2-dgi-allure-adapter.md#verification-on-2026-11-25-utc) · [04.2 final acceptance](acceptance-04.2.md#final-level-a-and-level-b-acceptance--2026-11-24)

## F. Hash and provenance checks

After the owner provides the evidence, review each UUID from the QEP directory. Run `node dist/cli.js results verify --run-id "$QEP_RUN_ID"` against the original run and `sha256sum` against the exact Summary v0, result and manifest bytes. Compare the recomputed file size and result digest with `manifest-v1.json` and the owner evidence. Compare the run, suite and SHA across the stored pair, summary and detached workspace HEAD. Check that each UUID is distinct, new, and associated with the recorded QEP baseline and CLI exit code. Verify the source snapshots and index digests before and after execution.

For DGI, independently reconcile manifest status counts and audited per-case hashes with the backend or frontend JUnit totals for the same workspace. Compare each case-ID set with the historical replay at the same SHA and check that execution IDs use the new UUID. For CLU, reconcile the XML totals, exit status and summary/XML digests in `clu-junit.receipt`. For each normalized result, confirm its unique case and execution IDs, all six counts, `PASS`, `COMPLETE`, child exit 0 and runner CLI exit 0. Record the exact hashes and discrepancies before making an acceptance decision. [Adapter paths and checks](adapters.md)

Before and after this preparation, DGI and CLU had matching branch, HEAD, clean status and Git index SHA-256. The DGI index digest was `8a02073df39fcfc20bf3712983720983033a2e4848f454a0611f88980b8b9073` and the CLU digest was `4d5017fbf2a878d0a87013cc8eb75507917c36abef4eb3db9e56431f30fa57c1`. Git status and index checks cover Git-visible source state. All 14 historical Summary v0 hashes matched the preparation baseline.

## G. Safety compliance

Preparation ran QEP checks and synthetic fixtures only. Source inspection and historical replay were read-only. The work stayed local apart from GitHub PR metadata reads. The acceptance workflow uses the catalog's unit profiles, which require neither Docker nor a database. No GitHub writes, secrets, sudo, host changes, report hosting or Allure 3 HTML generation occurred.

## H. Deferred features

Unified Allure 3 reporting, hosted reports, cross-repository consumer and candidate testing, and INFRA-04.8 branch protection remain deferred.

## I. GO / NO-GO recommendation

**GO for owner execution and evidence collection. NO-GO for final acceptance** until all three fresh results and manifests pass independent verification. QEP-only hosted CI remains pending for the acceptance changes before merge.

## INFRA-04.3 — Final Acceptance Closure

### A. Closure decision and date

**INFRA-04.3 — Closed — PASS** on 2026-11-25 UTC. Sections A–I above record the 2026-11-25 UTC preparation checkpoint. The fresh execution and read-only verification below establish the final status.

### B. Final implementation and merge provenance

QEP merged Result Contract v1, the DGI Allure adapter, the CLU JUnit adapter and Results CLI, and final acceptance preparation. Local first-parent history confirms the four merges. [QEP #10](https://github.com/Shaobangzhu/quality-engineering-platform/pull/10) · [QEP #11](https://github.com/Shaobangzhu/quality-engineering-platform/pull/11) · [QEP #12](https://github.com/Shaobangzhu/quality-engineering-platform/pull/12) · [QEP #13](https://github.com/Shaobangzhu/quality-engineering-platform/pull/13)

| QEP revision role | SHA |
| --- | --- |
| Execution baseline recorded in the retained runtime metadata | `08639f1bf7fefc5c8ff27b327c8969c3d3e42503` |
| PR #13 merge on `main` | `08639f1bf7fefc5c8ff27b327c8969c3d3e42503` |
| `docs/infra-04.3-final-closure` HEAD at documentation preflight | `08639f1bf7fefc5c8ff27b327c8969c3d3e42503` |

The execution baseline comes from the fresh run set's runtime record. The historical instructions above capture the preparation-time SHA.

### C. Hosted QEP and CLU CI evidence

- QEP hosted CI passed build, typecheck, lint and all 150 standard tests. The dedicated Contract v1 and adapter step passed 31/31. Those 31 tests are included in the 150. [QEP hosted CI](https://github.com/Shaobangzhu/quality-engineering-platform/actions/runs/45532400677)
- CLU merged the opt-in JUnit reporter in PR #17 at master SHA `8bda12f627e6234ed122fef29b48bd5ee2e2706d`. Hosted CLU CI passed. [CLU #17](https://github.com/Shaobangzhu/react-clu-component-lib/pull/17) · [CLU hosted CI](https://github.com/Shaobangzhu/react-clu-component-lib/actions/runs/45527591508)

### D. Three fresh Ubuntu execution results

The three runs completed on 2026-11-25 UTC with **529/529 unit tests passed**. Contract v1 recorded execution status `PASS` and zero failed, broken, skipped and unknown cases for each run.

| Suite ID | Run UUID | Source SHA | QEP execution baseline | Passed | Failed | Runner CLI exit | Child exit | Summary v0 status | Contract v1 collection state | Verification result |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| `dgi-backend-unit` | `af9dbaab-a9ba-40d3-b285-3762d8a2b558` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | `08639f1bf7fefc5c8ff27b327c8969c3d3e42503` | 189 | 0 | 0 | 0 | PASS | COMPLETE | PASS |
| `dgi-frontend-unit` | `4f258528-22f4-4b99-9f38-5c65d282da5b` | `2ef00a81e55e7d150770bfc81abffd96dffdc0b3` | `08639f1bf7fefc5c8ff27b327c8969c3d3e42503` | 257 | 0 | 0 | 0 | PASS | COMPLETE | PASS |
| `clu-unit` | `01ca49e4-dc10-4317-8362-99ec59dcf372` | `8bda12f627e6234ed122fef29b48bd5ee2e2706d` | `08639f1bf7fefc5c8ff27b327c8969c3d3e42503` | 83 | 0 | 0 | 0 | PASS | COMPLETE | PASS |

### E. Contract v1 and manifest verification

The Contract v1 parser validated each result's unique case and execution IDs and reconciled every status count with the case records. Each manifest named `result-v1.json` and matched its schema version, run UUID, suite, source commit, byte length and SHA-256. The hashes below were recomputed from retained files and matched the recorded checksum lists.

| Suite ID | Result bytes | Summary v0 SHA-256 | Result v1 SHA-256 | Manifest v1 SHA-256 |
| --- | ---: | --- | --- | --- |
| `dgi-backend-unit` | 47190 | `5f7aed865ca1a316d0d7b88ea76e945ea4e6bd3b9c608b1faa3038df505bff26` | `4d061b413764d88bfb3707971b2e9816b1209f7a6b2bc30a5e16f16b45105ad9` | `63b17245487c797d05afef79988799b73dd6897efddd4cfa58d96b1c22b27337` |
| `dgi-frontend-unit` | 64569 | `a1c680df0d68d14cc4171eb37644568cda55f4fa21f849d4dd9fb7651a91ee4c` | `8ced208b66607597351ff32fe922b854521196703fee0ea6f4cea2111ac44d5a` | `46a2f1c95c2cc8528c5744f033bab34b3aa88b65204cc6c68b53b321bea17911` |
| `clu-unit` | 19564 | `e6ecb0581cb0ecc7a4e98f238706f3342d0c26cf2b7d8162848d499da7e52dda` | `54bd57c3d952561843f9820b4dc21c7c1944db13bc580f80ce83df438e1f1f39` | `4602c65c29d1b190d5b2a16cff952d246ebe9f79af45114431d788d3af056262` |

### F. Independent read-only acceptance audit

The owner reported PASS for a separate independent read-only acceptance review. No standalone report was found in the authorized evidence, so that review's decision and scope are owner-reported.

This closure independently reproduced all three results and manifests through the read-only `results verify` handler. Each returned exit 0 and reproduced the retained verification output byte for byte. The handler revalidated the DGI Allure evidence and the CLU JUnit receipt's binding to Summary v0 and the JUnit XML. The retained collection, retry and verification records also agreed with each stored manifest.

### G. Source and workspace integrity

Summary v0 identified the approved repositories and commits for both DGI suites (`delivery-geo-intelligence`) and CLU (`react-clu-component-lib`, catalog identity `@shaobangzhu/clu-ui`). Each workspace's Git HEAD was detached at its recorded source SHA and had zero remotes. The three UUIDv4s were distinct, absent from the retained pre-run summary inventory, and consistent across their exit, outcome, summary, result and manifest records.

DGI and CLU before/after snapshots matched byte for byte, including branch, pinned HEAD, clean status and Git index digest. Those snapshots establish Git-visible source integrity for the execution window.

### H. Security boundary confirmation

This closure used retained metadata and read-only verification of the approved runs. The verifier processed the original reporter evidence locally, and the record publishes only identifiers, counts and integrity metadata. No suites were rerun, no dependencies were installed, and no runtime artifacts were changed. The execution boundary remains the reviewed catalog unit profiles and disposable workspaces. [Security boundaries](security-boundaries.md)

### I. Historical failures and remediation closure

The preparation checkpoint retains the restricted-session QEP fixture failures (`spawnSync git EPERM`) and the pending hosted CI and fresh evidence entries. Hosted QEP CI passed at the merge baseline, and the fresh Ubuntu run set cleared the pending evidence and verification conditions. Earlier attempts retain their recorded outcomes. INFRA-04.2 remains a separate acceptance record. [INFRA-04.2 final acceptance](acceptance-04.2.md#final-level-a-and-level-b-acceptance--2026-11-24)

### J. Deferred INFRA-04.4+ scope

INFRA-04.4 through INFRA-04.8 remain future work, including unified Allure 3 reporting, Nginx report hosting, cross-repository consumer and candidate testing, and INFRA-04.8 branch protection.

### K. Final GO / NO-GO decision

**GO — INFRA-04.3 — Closed — PASS**

- QEP implementation and hosted CI — PASS
- Real-source suites — 3/3 PASS
- Total unit tests — 529/529 PASS
- Contract v1 validation — PASS
- Result integrity and provenance — PASS
- Independent read-only acceptance — PASS for the checks reproduced in this closure. Separate audit PASS is owner-reported.
- Remaining 04.3 blocking items — None
