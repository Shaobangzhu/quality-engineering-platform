# Allure 3 runbook

Use the QEP checkout on ordinary Ubuntu with Linux procfs, `/usr/bin/flock`, Bash, `jq`, Node.js 22.23.4 and the QEP lockfile dependencies. If QEP dependencies need installation, run `npm ci --ignore-scripts` from the QEP root. Report commands use the existing `.local/runs` evidence and the pinned local Allure CLI. [Architecture and storage](allure3-architecture.md)

## 04.4.5 owner preflight and plan

Run these commands in a dedicated Bash session. Keep that session for the build after review. The CLI alias below uses the project's compiled `qe` entry point.

```bash
set -euo pipefail
umask 077
cd /home/clu/projects/quality-engineering-platform
test "$(git branch --show-current)" = test/infra-04.4.5-acceptance
test "$(node --version)" = v22.23.4
test -x /usr/bin/flock
command -v jq
npm run build

qe() { node ./dist/cli.js "$@"; }
runs=(
  af9dbaab-a9ba-40d3-b285-3762d8a2b558
  4f258528-22f4-4b99-9f38-5c65d282da5b
  01ca49e4-dc10-4317-8362-99ec59dcf372
)
selection=(--run-id "${runs[0]}" --run-id "${runs[1]}" --run-id "${runs[2]}")
expected_id=4a01f5da12c7404e80d4b1317eb312685e16f9cc85387f665d29828e264df6ee
expected_counts='{"total":529,"passed":529,"failed":0,"broken":0,"skipped":0,"unknown":0}'
audit=$(mktemp -d .local/acceptance-04.4.5.XXXXXX)
for run in "${runs[@]}"; do
  input=".local/runs/$run"
  sha256sum "$input/summary.json" "$input/results-v1/result-v1.json" \
    "$input/results-v1/manifest-v1.json" >> "$audit/inputs.sha256"
  qe results verify --run-id "$run" | tee "$audit/$run.verify.json"
done

report_inventory() {
  if [[ -d .local/reports ]]; then
    find .local/reports -mindepth 1 -maxdepth 2 -printf '%p\t%y\t%m\t%s\t%T@\n' | LC_ALL=C sort
  fi
}
for existing in .local/reports/*; do
  [[ ${existing##*/} =~ ^[a-f0-9]{64}$ && -f "$existing/report-manifest.json" ]] || continue
  sha256sum "$existing/report-manifest.json"
  if [[ -f "$existing/history.jsonl" ]]; then
    sha256sum "$existing/history.jsonl"
  fi
done > "$audit/prior-report-history.sha256"
report_inventory > "$audit/reports-before-plan.tsv"
qe report plan "${selection[@]}" | tee "$audit/plan.json"
jq -e --arg id "$expected_id" --argjson counts "$expected_counts" '
  .status == "planned" and .reportId == $id and .directory == (".local/reports/" + $id)
  and .generator == {name: "allure", version: "3.33.0"} and .counts == $counts
  and ([.runs[].counts.passed] | sort) == [83, 189, 257]
' "$audit/plan.json"
report_inventory > "$audit/reports-after-plan.tsv"
cmp "$audit/reports-before-plan.tsv" "$audit/reports-after-plan.tsv"
sha256sum -c "$audit/inputs.sha256"
```

Review the three source SHAs, UUIDs, Contract v1 hashes and status counts in the plan against the [preparation evidence](acceptance-04.4.md#d-three-verified-input-runs). `planned` is an eligibility and export check. The plan records the intended report directory.

## Owner build, verify and retry

After reviewing the plan, the owner runs this block in the same session. The first build normally returns `built`. If the target already exists and verifies, it returns `reused`. In that case, record the first invocation as reuse of the existing report.

```bash
report=$(jq -er '.directory' "$audit/plan.json")
qe report build "${selection[@]}" | tee "$audit/build.json"
jq -e --arg id "$expected_id" '
  .reportId == $id and (.status == "built" or .status == "reused")
' "$audit/build.json"
qe report verify "${selection[@]}" | tee "$audit/verify.json"
jq -e --arg id "$expected_id" --argjson counts "$expected_counts" '
  .status == "verified" and .reportId == $id and .counts == $counts
' "$audit/verify.json"

report_files=(history.jsonl index.html report-manifest.json summary.json test-results.json)
qep_report_files() {
  find "$report" -mindepth 1 -maxdepth 1 -printf '%f\t%y\t%m\t%s\n' | LC_ALL=C sort
}
qep_report_files > "$audit/report-files.tsv"
diff -u <(printf '%s\n' "${report_files[@]}") <(cut -f1 "$audit/report-files.tsv")
awk -F '\t' '$2 != "f" || $3 != "600" { exit 1 }' "$audit/report-files.tsv"
test "$(stat -c '%a' "$report")" = 700
test "$(wc -l < "$report/history.jsonl")" -eq 1
cp "$report/report-manifest.json" "$audit/report-manifest.json"
jq -e --arg id "$expected_id" --argjson counts "$expected_counts" '
  .schemaVersion == 2 and .reportId == $id and .counts == $counts
  and ([.files[].name] | sort) == ["history.jsonl", "index.html", "summary.json", "test-results.json"]
' "$audit/report-manifest.json"
(cd "$report" && jq -r '.files[] | "\(.sha256)  \(.name)"' report-manifest.json | sha256sum -c -)
while IFS=$'\t' read -r file bytes; do
  test "$(stat -c '%s' "$report/$file")" = "$bytes"
done < <(jq -r '.files[] | [.name, .bytes] | @tsv' "$audit/report-manifest.json")
(cd "$report" && sha256sum "${report_files[@]}") > "$audit/report.sha256"
report_inventory > "$audit/reports-after-build.tsv"

qe report build "${selection[@]}" | tee "$audit/repeat.json"
jq -e --arg id "$expected_id" '.status == "reused" and .reportId == $id' "$audit/repeat.json"
qe report verify "${selection[@]}" | tee "$audit/verify-after-repeat.json"
cmp "$audit/verify.json" "$audit/verify-after-repeat.json"
report_inventory > "$audit/reports-after-repeat.tsv"
cmp "$audit/reports-after-build.tsv" "$audit/reports-after-repeat.tsv"
(cd "$report" && sha256sum -c -) < "$audit/report.sha256"
if [[ -s "$audit/prior-report-history.sha256" ]]; then
  sha256sum -c "$audit/prior-report-history.sha256"
fi
sha256sum -c "$audit/inputs.sha256"
printf 'Private audit evidence at %s\n' "$audit"
```

The JSON `history` receipt records the publication sequence and predecessor. For the first schema-v2 launch, expect `acceptedLaunches: 1` and `previousReportId: null`. With accepted history already present, confirm the new receipt follows the previous one and that the earlier report inventory stays intact. Compare the post-build and post-repeat evidence to confirm reuse leaves history unchanged. Exit `1` means a selected run verified as unsuccessful. Exit `2` indicates invalid evidence, a report or history problem, or a build failure. Retain an error and its evidence if a command fails. [Recovery and storage limits](runbook.md#local-history-and-recovery)

## Independent acceptance review

Provide the reviewer access to the local report, the `audit` directory and the three retained QEP runs. Keep the files private. The review checks the following evidence.

1. Reverify the three Contract v1 pairs and reconcile the report manifest's sorted UUIDs, suite and repository identities, source SHAs, execution statuses, counts and input digests.
2. Confirm all 529 cases passed across Allure's summary, case index, and the rendered data embedded in `index.html`. Verify that the verified contracts contain 529 unique logical case IDs and 529 unique execution IDs. For each execution, derive its Allure result UUID using the first 16 bytes of SHA-256 over `qep-allure-execution-v1\0` followed by the execution ID, with UUID version 8 and variant bits set. Allure's case index uses the MD5 of the UUID string. Compare the entire index ID set and each embedded case's external ID, status and approved labels against the contracts.
3. Confirm the report has the five expected regular files. Check every manifested size and SHA-256, the single-file HTML format and the local content policy. Inspect the embedded case, global and history data for raw diagnostic payloads, including attachments, steps, errors, raw test names and original paths. QEP's approved case names use the first 12 hex digits of the case digest.
4. Confirm the original run checksums match the preflight and the 04.3 closure. Match the history line and its receipt to the accepted sequence and confirm that repeat generation returned `reused` with identical report bytes and directory inventory.

Open the private report's `index.html` locally to inspect the static viewer. [Acceptance checklist and readiness status](acceptance-04.4.md)
