# QEP hosting acceptance and rollback

INFRA-04.5.1 verifies the selected Allure report against the source runs,
manifest, accepted history, and public HTML policy before promoting a
single-file release. INFRA-04.5.2 serves that file through the relative
`current` symlink using a dedicated, read-only Nginx container. Use the
Run IDs and report ID from the reviewed Allure launch for acceptance.
[Promotion workflow](allure3-runbook.md#0451-static-site-promotion) ·
[Nginx deployment and owner preflight](infra-04.5.2-report-hosting.md)

## Ubuntu host acceptance

Run these commands as the authorized QEP owner from the repository root in
Bash. Use the approved local Docker context on Ubuntu. The deployment
prerequisites include Docker Engine 28 or later with normal bridge isolation
and no direct routing to the report bridge. [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)

Build the CLI, enter the reviewed identifiers, and collect the database
container baseline before any hosting start, stop, or rollback in this
acceptance session. Enter all existing DB container names or IDs as a
space-separated list. The snapshot records only container identity and
lifecycle state.

```bash
set -euo pipefail
dc() {
  docker compose --env-file /dev/null --project-name qep-report-hosting \
    --file "$PWD/deploy/report-hosting/compose.yaml" "$@"
}
db_state() {
  docker inspect --type container --format \
    '{{.Id}} {{.Name}} {{.State.Status}} {{.State.StartedAt}} {{.State.FinishedAt}} {{.RestartCount}}' \
    "$@" | LC_ALL=C sort
}
check_db_state() {
  local db_after
  db_after=$(db_state "${db_containers[@]}") || return
  if [[ "$db_before" != "$db_after" ]]; then
    diff -u <(printf '%s\n' "$db_before") <(printf '%s\n' "$db_after")
  fi
}

npm run build
read -rp 'Reviewed report ID: ' REPORT_ID
read -rp 'Reviewed QEP Run IDs (space separated): ' -a run_ids
test "${#run_ids[@]}" -gt 0
selectors=()
for id in "${run_ids[@]}"; do selectors+=(--run-id "$id"); done
read -rp 'Existing DB containers (space separated): ' -a db_containers
test "${#db_containers[@]}" -gt 0
db_before=$(db_state "${db_containers[@]}")
node dist/cli.js site verify "${selectors[@]}" | node -e '
  const assert = require("node:assert/strict");
  const release = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.equal(release.reportId, process.argv[1]);
  console.log(JSON.stringify(release));
' "$REPORT_ID"
dc config --quiet
```

If the service is stopped, the owner can start only `nginx` after completing
the deployment preflight and verifying the current release. Continue with
the checks below once the service is running.
[Owner deployment prerequisites and startup](infra-04.5.2-report-hosting.md#owner-deployment-prerequisites-and-runtime-checks)

```bash
test "$(dc port nginx 8080)" = '127.0.0.1:7300'
cid=$(dc ps -q nginx)
test -n "$cid"
docker inspect --format '[{{json .Config.Labels}},{{json .Config.User}},{{json .HostConfig}},{{json .Mounts}},{{json .NetworkSettings}}]' "$cid" | node -e '
  const assert = require("node:assert/strict");
  const [labels, user, HostConfig, Mounts, NetworkSettings] =
    JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const ports = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "7300" }] };
  assert.deepEqual(HostConfig.PortBindings, ports);
  assert.deepEqual(NetworkSettings.Ports, ports);
  assert.equal(labels["com.docker.compose.project"], "qep-report-hosting");
  assert.equal(labels["com.docker.compose.service"], "nginx");
  assert.deepEqual(Object.keys(NetworkSettings.Networks), ["qep-report-hosting_default"]);
  assert.equal(HostConfig.ReadonlyRootfs, true);
  assert.equal(HostConfig.Privileged, false);
  assert.equal(user, "101:101");
  assert.deepEqual(HostConfig.VolumesFrom ?? [], []);
  assert.deepEqual(HostConfig.Devices ?? [], []);
  const binds = Mounts.filter(m => m.Type === "bind")
    .map(m => [m.Destination, m.Source, m.RW]).sort();
  assert.deepEqual(binds, [
    ["/etc/nginx/nginx.conf", process.argv[1], false],
    ["/srv/qep-public", "/home/clu/infra/qep-report-site", false]
  ]);
  assert.ok(Mounts.every(m => m.Type === "bind" || (m.Type === "tmpfs" && m.Destination === "/tmp")));
' "$PWD/deploy/report-hosting/nginx.conf"
test "$(docker network inspect --format '{{range $id, $c := .Containers}}{{println $id}}{{end}}' qep-report-hosting_default)" = "$cid"
ss -H -ltn 'sport = :7300' | awk '
  { print }
  $4 != "127.0.0.1:7300" { unexpected = 1 }
  END { exit unexpected }
'
dc exec -T nginx sh -ec '
  test "$(id -u):$(id -g)" = 101:101
  test -r /srv/qep-public/current/index.html
  test ! -S /var/run/docker.sock
  test ! -S /run/docker.sock
  ps -o pid,user,group,args
'
```

The port bindings must contain only `127.0.0.1:7300` for `8080/tcp`.
The `ss` check fails on any listener outside IPv4 loopback, including
`0.0.0.0:7300`, `[::]:7300`, and `*:7300`. Docker can publish the port through
NAT without a listening process in `ss`, so the configured and active mappings
are checked too. Confirm Nginx master and worker run as the unprivileged account.

After the host checks pass, run the smoke script without a concurrent
promotion or service reconfiguration.

```bash
node scripts/hosting-smoke.js --report-id "$REPORT_ID" "${selectors[@]}"
check_db_state
```

The script exits nonzero at the first failure. On success it prints
`status`, `reportId`, `sha256`, and `bytes`. Record this result alongside
the reviewed Run IDs and the before-and-after DB comparison. Confirm the
DB container IDs, statuses, timestamps, and restart counts match. If any
check fails, investigate before accepting the release. The owner can stop
only the report service with `dc stop nginx` if it needs to be taken offline.

The script first verifies that the reviewed Run IDs resolve to the specified
report ID and that `current/index.html` matches the verified Allure artifact.
It checks HTTP 200 and HTML MIME type for GET on both report URLs and HEAD
on `/index.html`. It hashes the exact GET bytes, including a query-string
probe, and checks them against the verifier's SHA-256. Private metadata,
unsupported paths, the direct release URL, and normalized aliases must
return the generic 404.
Bodyless POST, PUT, PATCH, and DELETE probes use a deliberately nonmatching
`If-Match` value on both report URLs and must return 403. Run these probes
only after the host checks confirm the report mount and container root are
read-only. The script repeats the GET hashes and deployed release verification
after the write probes.

Both successful and denied responses must carry `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and the approved HTTP CSP. The CSP preserves
the directives needed by the report and adds restrictions on base URLs,
form submissions, and framing. The body hash also verifies that the
report's embedded CSP is served byte for byte.

## Mac access through VS Code Remote-SSH

1. From VS Code on the Mac, run **Remote-SSH: Connect to Host** and select the
   approved Ubuntu SSH host.
2. In that remote window, open **Ports: Focus on Ports View** and use
   **Forward a Port** for remote `127.0.0.1:7300`. Enter `7300` if the
   prompt requests a port number. Confirm the forwarded address is
   `localhost:7300`. If VS Code selected another local port, free the
   conflicting port on the Mac and use **Change Local Address Port** to set
   it to `7300`. Keep the forward on local loopback.
3. Open `http://localhost:7300/` on the Mac. Check the reviewed launch's
   summary counts and representative suite and case names, open a case, and
   verify that report navigation and any charts render. Check the browser
   console for CSP violations that prevent the report from working.
4. In a **Mac** terminal, run the command below. Compare the digest with the
   Ubuntu smoke result. Close the forwarded port when finished.

```bash
set -o pipefail
curl --noproxy '*' --fail --silent --show-error --max-time 15 \
  -H 'Accept-Encoding: identity' http://localhost:7300/index.html | shasum -a 256
```

[VS Code Remote-SSH port forwarding](https://code.visualstudio.com/docs/remote/ssh#_forwarding-a-port-creating-ssh-tunnel)

## Manual rollback to a previously accepted release

Use the earlier acceptance record for the previous report ID, HTML SHA-256,
and Run IDs. Coordinate with other publishers so the plan, promotion, and
verification run as one operator sequence. The promotion CLI uses its
publication lock and atomically switches `current` to the earlier release
after revalidating it. Keep both release directories and use the CLI
throughout.

```bash
read -rp 'Previously accepted report ID: ' PREVIOUS_REPORT_ID
read -rp 'Previously accepted index SHA-256: ' PREVIOUS_SHA256
read -rp 'Previously accepted QEP Run IDs (space separated): ' -a previous_runs
test "${#previous_runs[@]}" -gt 0
previous=()
for id in "${previous_runs[@]}"; do previous+=(--run-id "$id"); done

node dist/cli.js site plan "${previous[@]}" | node -e '
  const assert = require("node:assert/strict");
  const plan = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.equal(plan.status, "planned");
  assert.ok(["activate", "reuse"].includes(plan.operation), "Accepted release must already exist");
  assert.equal(plan.reportId, process.argv[1]);
  assert.equal(plan.index.sha256, process.argv[2]);
' "$PREVIOUS_REPORT_ID" "$PREVIOUS_SHA256"
```

After the plan passes, explicitly authorize the switch and verify it.
A healthy running Nginx instance sees the switch on new requests.

```bash
node dist/cli.js site promote "${previous[@]}" --publish
node dist/cli.js site verify "${previous[@]}"
node scripts/hosting-smoke.js --report-id "$PREVIOUS_REPORT_ID" "${previous[@]}" | node -e '
  const assert = require("node:assert/strict");
  const smoke = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.equal(smoke.sha256, process.argv[1]);
  console.log(JSON.stringify(smoke));
' "$PREVIOUS_SHA256"
check_db_state
```

If this is a separate acceptance session, take a fresh DB baseline before
rollback. If the plan fails or the accepted release is missing or corrupt,
stop the rollback and recover the verified artifact through the promotion
workflow. If the report service was stopped, complete the owner preflight,
start it, and repeat the host checks before rerunning the HTTP smoke.
Recheck the Mac digest and navigation when accepting the restored release
over Remote-SSH.

## Diagnosis

| Symptom | Checks and recovery |
| --- | --- |
| Missing current release | Run `readlink /home/clu/infra/qep-report-site/current` and `namei -l /home/clu/infra/qep-report-site/current/index.html`. Check that `current` points to `releases/<report-id>`, the release exists, and the report is readable. Use the verified promotion workflow for a missing pointer. For a dangling pointer or a damaged release that the publisher rejects, keep the service offline and recover the accepted release tree from trusted evidence before running `site verify`. |
| HTTP 404 on a report URL | A 404 is expected for all unsupported paths. For `/` or `/index.html`, run `site verify`, inspect the bind source, and use the `dc exec` readability check above. Check `dc ps nginx` and `dc logs --tail 50 nginx`. Test from Ubuntu first to distinguish Nginx from Mac forwarding. |
| Port 7300 conflict | On Ubuntu, check `ss -H -ltnp 'sport = :7300'`, `docker ps --filter publish=7300`, and `dc port nginx 8080`. On Mac, check `lsof -nP -iTCP:7300 -sTCP:LISTEN` and the VS Code Ports view. Resolve the conflict with the process owner before retrying. |
| Docker socket permission denied | On Ubuntu check `docker context show`, `id`, and the approved context's socket ownership. For a local default context use `ls -l /var/run/docker.sock`. Ask the host administrator to restore approved access and reconnect if group membership changed. Keep the socket permissions and container mount policy intact. |
| Missing Nginx temp directory | Inspect `dc logs --tail 50 nginx` and `dc config`. Verify that the running container has the approved writable `/tmp` tmpfs for UID/GID 101 and the mounted configuration points each Nginx temp path under `/tmp`. If it is running, check `dc exec -T nginx ls -ld /tmp /tmp/client_body /tmp/proxy /tmp/fastcgi /tmp/uwsgi /tmp/scgi`. Restore the approved config and recreate only the report service through owner deployment preflight. |
| Report hash mismatch | Repeat `site verify` with the reviewed Run IDs. Compare its digest with `sha256sum /home/clu/infra/qep-report-site/current/index.html`. If site verification succeeds, check the active mount, port owner, any concurrent promotion, and whether the browser is using the expected forward. Rerun the Ubuntu smoke with the reviewed report ID before checking the Mac digest. |
| Stale browser report | Compare the Mac digest with Ubuntu's smoke result. If the hashes match, reload with the browser cache disabled or use a private window and reopen the launch. If they differ, check the local port owner, close and recreate the VS Code forward to the correct Ubuntu host, then repeat the Mac digest. |

## Synthetic CI validation

`npm test` runs the hosting smoke tests against synthetic HTTP response
streams. The promotion suite also verifies the smoke against an Allure
report built from synthetic run fixtures and promoted into a temporary
directory. The static hosting tests check the Compose and Nginx policy,
including the relationship between the HTTP and embedded CSP. Hosted QEP CI
uses these fixtures with no Docker, listening socket, live report, or Mac
connection. Live acceptance is an owner action.
