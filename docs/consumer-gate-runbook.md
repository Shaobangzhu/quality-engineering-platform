# CLU-to-DGI consumer gate owner runbook

Run this procedure from an ordinary Ubuntu Terminal on the QEP host. Use the QEP development dependencies already installed, Node `22.23.4` from `.nvmrc`, npm `10.9.0` or later, and Git with `clone --revision`. If using nvm, run `cd /home/clu/projects/quality-engineering-platform && nvm use` first.

After INFRA-04.6.5.1B is merged, refresh `origin/main` with `git fetch origin` and check out the exact reviewed QEP commit that contains the merged change. Enter its full SHA at the QEP prompt. The procedure checks that this commit is on `origin/main`, contains the acceptance-preparation merge, and matches a clean local checkout. Build this checkout with `npm run build` and perform the 04.5 protection check below before executing the gate.

Review CLU's package manifest, lockfile, unit tests, build configuration and declaration build script at the exact candidate commit. Enter its full approved SHA at the CLU prompt. The initial example is `8bda12f627e6234ed122fef29b48bd5ee2e2706d`. Use the actual reviewed SHA if the selection changes. Set `clu_original` to the approved local checkout for that SHA if its location differs. DGI is pinned to the reviewed merge `29deef59cd840e9bfc0fe98cf51dc72a5aa0b337`.

The original CLU checkout had ignored `dist/` output during preparation. The gate rejects this during planning. The procedure checks both original repositories and creates a fresh local CLU checkout at the approved SHA with no pre-existing build output. The original CLU tree and its build output stay in place. If either original path, HEAD or Git status is unexpected, stop and reconcile the input with the owner review before trying again.

## Plan, verify, authorize and run

The `RUN` prompt authorizes the displayed sequence and dependency installation after the plan has been checked. The gate runs CLU unit and package checks, followed by DGI baseline and candidate checks, in one evaluation. All three installs use `npm ci --ignore-scripts --include=dev` in private workspaces and can reach the npm registry. The DGI quality builds use `NODE_ENV=production`. The baseline tests check the published registry pin, and the candidate tests receive the verified archive's SHA-512 SRI after QEP verifies the installed package bytes.

```bash
bash <<'BASH'
set -euo pipefail
umask 077
cd /home/clu/projects/quality-engineering-platform

qep_preparation=22507654d58caa8c719bc35a2850da6c03bca1fe
dgi_sha=29deef59cd840e9bfc0fe98cf51dc72a5aa0b337
dgi_original=/home/clu/projects/delivery-geo-intelligence
clu_original=/home/clu/projects/react-clu-component-lib
clu_origin=https://github.com/Shaobangzhu/react-clu-component-lib.git

die() { printf '%s\n' "$*" >&2; exit 1; }
source_git() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 \
    git --no-optional-locks --no-lazy-fetch --no-replace-objects \
    -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.untrackedCache=false \
    -c core.excludesFile=/dev/null -c core.attributesFile=/dev/null "$@"
}

read -r -p 'Enter the reviewed merged QEP SHA (40 lowercase hex characters): ' qep_sha </dev/tty
[[ $qep_sha =~ ^[0-9a-f]{40}$ ]] || die 'Use the full reviewed QEP SHA.'
verify_qep_checkout() {
  local status
  [[ $(source_git rev-parse --verify 'HEAD^{commit}') == "$qep_sha" ]] || die 'Unexpected QEP HEAD.'
  source_git merge-base --is-ancestor "$qep_sha" refs/remotes/origin/main \
    || die 'Reviewed QEP commit is missing from origin/main. Refresh the remote reference and check the SHA.'
  source_git merge-base --is-ancestor "$qep_preparation" "$qep_sha" \
    || die 'QEP acceptance preparation merge is missing.'
  status=$(source_git status --porcelain=v1 --untracked-files=all) || die 'Unable to inspect QEP checkout status.'
  [[ -z $status ]] || die 'QEP checkout has local changes.'
}
verify_qep_checkout
[[ $(uname -s) == Linux && -d /proc/self/fd && $(node --version) == "v$(<.nvmrc)" ]] \
  || die 'Use the QEP Node runtime on the Ubuntu host.'
node -e 'if (!require("semver").gte(process.argv[1], "10.9.0")) process.exit(1)' "$(npm --version)"
git_help=$(LC_ALL=C git clone -h 2>&1 || true)
[[ $git_help == *--revision* || $git_help == *'--[no-]revision'* ]] \
  || die 'Git must support clone --revision.'
npm run build
node --input-type=module - "$dgi_sha" <<'NODE'
import assert from 'node:assert/strict';
import { reviewedConsumerDgiSha } from './dist/suite-catalog.js';
assert.equal(reviewedConsumerDgiSha, process.argv[2]);
NODE

read -r -p 'Enter the reviewed CLU candidate SHA (40 lowercase hex characters): ' clu_sha </dev/tty
[[ $clu_sha =~ ^[0-9a-f]{40}$ ]] || die 'Use the full reviewed CLU SHA.'

source_snapshot() {
  local repo=$1 expected_sha=$2 head ref status
  [[ $(source_git -C "$repo" rev-parse --show-toplevel) == "$repo" ]] \
    || die "Unexpected source root at $repo"
  head=$(source_git -C "$repo" rev-parse --verify 'HEAD^{commit}')
  [[ $head == "$expected_sha" ]] || die "Unexpected source HEAD at $repo"
  ref=$(source_git -C "$repo" rev-parse --symbolic-full-name HEAD)
  status=$(source_git -C "$repo" status --porcelain=v1 --untracked-files=all)
  [[ -z $status ]] || die "Source has tracked or unignored changes at $repo"
  printf 'root=%s\nref=%s\nhead=%s\nstatus=%s\n' "$repo" "$ref" "$head" "$status"
  sha256sum "$repo/.git/index"
}

mkdir -p -m 700 .local
evidence=$(mktemp -d "$PWD/.local/acceptance-04.6.5.XXXXXXXX")
printf 'Private owner evidence directory %s\n' "$evidence"
printf '%s\n' "$qep_sha" > "$evidence/qep-head.txt"
source_snapshot "$clu_original" "$clu_sha" > "$evidence/clu-original.before"
source_snapshot "$dgi_original" "$dgi_sha" > "$evidence/dgi-original.before"
node --input-type=module - "$clu_original" "$clu_sha" "$dgi_original" "$dgi_sha" <<'NODE'
import { checkCluOrigin } from './dist/clu-candidate.js';
import { checkDgiOrigin } from './dist/dgi-candidate.js';
import { inspectWorkspace } from './dist/workspace.js';
const [clu, cluSha, dgi, dgiSha] = process.argv.slice(2);
inspectWorkspace({ suite: 'clu-unit', source: clu, sha: cluSha }, 'consumer-gate');
inspectWorkspace({ suite: 'dgi-frontend-unit', source: dgi, sha: dgiSha }, 'consumer-gate');
checkCluOrigin(clu);
checkDgiOrigin(dgi);
NODE

# Prepare a clean source copy with a full local object database.
clu_source="$evidence/clu-source"
GIT_ALLOW_PROTOCOL=file source_git clone --template= --no-local --no-hardlinks --no-tags --no-checkout \
  --revision "$clu_sha" -- "$clu_original" "$clu_source"
source_git -C "$clu_source" config --local remote.origin.url "$clu_origin"
source_git -C "$clu_source" checkout --detach "$clu_sha" --
source_snapshot "$clu_source" "$clu_sha" > "$evidence/clu-source.before"

selectors=(--clu-source "$clu_source" --clu-sha "$clu_sha"
           --dgi-source "$dgi_original" --dgi-sha "$dgi_sha")
node dist/cli.js consumer plan "${selectors[@]}" > "$evidence/plan.json"
node - "$evidence/plan.json" "$clu_source" "$clu_sha" "$dgi_original" "$dgi_sha" <<'NODE'
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const [planPath, cluPath, cluSha, dgiPath, dgiSha] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const install = ['ci', '--ignore-scripts', '--include=dev'];
const frontend = [install, ['run', 'typecheck', '-w', 'frontend'],
  ['run', 'build', '-w', 'frontend', '--', '--mode', 'quality'], ['run', 'test:frontend']];
assert.equal(plan.mode, 'plan');
assert.equal(plan.executable, 'npm');
assert.equal(plan.timeoutMs, 300000);
assert.deepEqual(plan.executionRequires, ['--execute', '--install-deps']);
assert.deepEqual(plan.sources, {
  clu: { repository: '@shaobangzhu/clu-ui', path: cluPath, sha: cluSha },
  dgi: { repository: 'delivery-geo-intelligence', path: dgiPath, sha: dgiSha },
});
assert.deepEqual(plan.stages, [
  { name: 'clu', commands: [['--version'], install, ['test', '--ignore-scripts'],
    ['run', 'build', '--ignore-scripts'],
    ['pack', '--ignore-scripts', '--json', '--pack-destination', '<private-pack-directory>']] },
  { name: 'baseline', dependency: 'published CLU from the original lockfile', commands: frontend },
  { name: 'candidate', dependency: 'exact archive from the CLU stage', commands: frontend },
  { name: 'compare' },
]);
NODE
sha256sum "$evidence/plan.json" > "$evidence/plan.sha256"
cat "$evidence/plan.json"
printf '\nTo authorize execution and dependency installation, type RUN %s %s\n' "$clu_sha" "$dgi_sha"
read -r approval </dev/tty
[[ $approval == "RUN $clu_sha $dgi_sha" ]] || die 'Execution was not authorized.'

compare_sources() {
  local check=$1 source
  source_snapshot "$clu_original" "$clu_sha" > "$evidence/clu-original.$check"
  source_snapshot "$dgi_original" "$dgi_sha" > "$evidence/dgi-original.$check"
  source_snapshot "$clu_source" "$clu_sha" > "$evidence/clu-source.$check"
  for source in clu-original dgi-original clu-source; do
    cmp "$evidence/$source.before" "$evidence/$source.$check"
  done
}

verify_qep_checkout
compare_sources pre-run
sha256sum -c "$evidence/plan.sha256"
node dist/cli.js consumer plan "${selectors[@]}" > "$evidence/plan.pre-run.json"
cmp "$evidence/plan.json" "$evidence/plan.pre-run.json"
run_status=0
node dist/cli.js consumer run --execute --install-deps "${selectors[@]}" \
  > "$evidence/run.stdout.json" 2> "$evidence/run.stderr.log" || run_status=$?
printf '%s\n' "$run_status" > "$evidence/run.exit"

# Compare the original repositories and the planned CLU input even on a gate failure.
compare_sources after
printf 'Source HEAD, reference, status and index match the pre-run snapshots.\n'

run_output="$evidence/run.stdout.json"
if (( run_status != 0 )); then run_output="$evidence/run.stderr.log"; fi
if ! issuance=$(node - "$run_output" <<'NODE'
const { readFileSync } = require('node:fs');
const { evaluationId, manifestSha256 } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(evaluationId) ||
    !/^[a-f0-9]{64}$/.test(manifestSha256)) process.exit(1);
console.log(evaluationId, manifestSha256);
NODE
); then
  die "No sealed evaluation was reported. Check run exit $run_status and logs in $evidence."
fi
printf '%s\n' "$issuance" > "$evidence/issuance.txt"
IFS=' ' read -r evaluation_id trusted_manifest_sha256 <<< "$issuance"
node dist/cli.js consumer verify --evaluation-id "$evaluation_id" --json \
  --clu-sha "$clu_sha" --dgi-sha "$dgi_sha" --manifest-sha256 "$trusted_manifest_sha256" \
  > "$evidence/verification.json"
node - "$evidence/verification.json" "$run_status" <<'NODE'
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const [path, exitCode] = process.argv.slice(2);
const { verified, manifestSha256, record } = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(verified, true);
assert.equal(record.decision.cliExitCode, Number(exitCode));
const { clu, baseline, candidate } = record.phases;
console.log(JSON.stringify({
  evaluationId: record.evaluationId, manifestSha256, commits: record.commits,
  archive: record.archive, locks: record.locks, decision: record.decision,
  clu: { status: clu.status, observedPasses: clu.observedPasses },
  baseline: { status: baseline.status, published: baseline.published,
    counts: baseline.tests?.counts, casesSha256: baseline.tests?.casesSha256 },
  candidate: { status: candidate.status, installed: candidate.installed, exports: candidate.exports,
    counts: candidate.tests?.counts, casesSha256: candidate.tests?.casesSha256 },
}, null, 2));
if (record.decision.status !== 'PASS') process.exitCode = record.decision.cliExitCode || 1;
NODE
BASH
```

Retain `plan.json`, the execution exit and output, `issuance.txt`, the source comparisons and `verification.json` privately alongside the evaluation UUID. Preserve the issuance digest separately from the sealed evaluation for later verification. Review the record's steps for CLU unit, build and pack, and for both DGI typecheck, build and test phases. Compare the published registry resolution with the installed candidate file resolution, the archive SRI, the React version, the original and patched lockfile digests, the audited counts and the case hash.

## Read-only 04.5 report and serving check

Use the following commands from the built, reviewed QEP checkout before owner execution and again after it returns, including after a failed or blocked gate. Retain both outputs with the evaluation evidence. Each check verifies the private accepted report, Allure history and active Nginx HTML using the three accepted Run IDs. The verified result should show 529 passing cases and one accepted history launch. Both HTTP responses must match the accepted SHA-256.

```bash
bash <<'BASH'
set -euo pipefail
cd /home/clu/projects/quality-engineering-platform
report_id=4a01f5da12c7404e80d4b1317eb312685e16f9cc85387f665d29828e264df6ee
html_sha=d54c2d237e6c121e364729ea1b941bdfe8e6d1a394e76c8a474c0706ae630ad6
runs=(--run-id af9dbaab-a9ba-40d3-b285-3762d8a2b558
      --run-id 4f258528-22f4-4b99-9f38-5c65d282da5b
      --run-id 01ca49e4-dc10-4317-8362-99ec59dcf372)
node dist/cli.js report verify "${runs[@]}" | node -e '
  const assert = require("node:assert/strict");
  const report = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.equal(report.status, "verified");
  assert.equal(report.reportId, process.argv[1]);
  assert.equal(report.counts.total, 529);
  assert.equal(report.counts.passed, 529);
  assert.deepEqual(report.history, { acceptedLaunches: 1, previousReportId: null });
  console.log("Accepted private report and history verified");
' "$report_id"
node dist/cli.js site verify "${runs[@]}" | node -e '
  const assert = require("node:assert/strict");
  const site = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.equal(site.status, "verified");
  assert.equal(site.reportId, process.argv[1]);
  assert.equal(site.index.sha256, process.argv[2]);
  assert.equal(site.index.bytes, 3104756);
  console.log("Accepted Nginx release verified on disk");
' "$report_id" "$html_sha"
for route in / /index.html; do
  digest=$(curl --noproxy '*' --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:7300$route" | sha256sum)
  [[ ${digest%% *} == "$html_sha" ]]
  printf '%s %s\n' "$route" "$html_sha"
done
BASH
```

## Acceptance status

| Status | Required evidence |
| --- | --- |
| Synthetic validation PASS | Build, typecheck, lint, standard QEP suite and the QEP-only consumer fixtures pass. |
| Real-source integration pending | An owner run at the approved source SHAs and its independent verification are still due. A plan only confirms preflight. |
| Real-source integration verified | The owner retains a run exit of `0`, `verified: true`, a `PASS` decision, all three passing phases, matching audited DGI cases and preserved source and hosting evidence. |

If a run produces valid evidence with `FAIL` or `BLOCKED`, keep the evaluation and record its decision and reason. Report any source or hosting discrepancy with the associated verification output. Stop on unsafe cleanup and retain the lock and scratch directory for inspection before retrying. [Evidence contract](infra-04.6.4-consumer-evidence.md) · [Acceptance preparation](acceptance-04.6.md)
