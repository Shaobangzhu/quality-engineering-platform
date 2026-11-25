# INFRA-04.5.2 · Loopback Allure hosting

| File | Purpose |
| --- | --- |
| [deploy/report-hosting/compose.yaml](../deploy/report-hosting/compose.yaml) | Dedicated `qep-report-hosting` project with one Nginx service. |
| [deploy/report-hosting/nginx.conf](../deploy/report-hosting/nginx.conf) | Complete Nginx configuration for the single-file report. |
| [test/report-hosting.test.js](../test/report-hosting.test.js) | Daemon-free checks run by the standard QEP test suite. |

## Image review

On 2026-11-25, the NGINX-maintained GHCR package listed
`ghcr.io/nginx/nginx-unprivileged:1.30.8-alpine3.24-slim` with OCI index digest
`sha256:04c98c78c1de60ddeada00d7d2207dcd146ecd07b61b9941c9a5799cfb258d28`.
The index includes `linux/amd64` and `linux/arm64`. NGINX listed 1.30.8 as the stable
release, and its security advisories identify 1.30.8 as fixing CVE-2026-132779.
[Exact GHCR package version](https://github.com/nginx/docker-nginx-unprivileged/pkgs/container/nginx-unprivileged/1621654446?tag=1.30.8-alpine3.24-slim) · [NGINX releases](https://nginx.org/en/download.html) · [NGINX security advisories](https://nginx.org/en/security_advisories.html)

The upstream Alpine slim build uses the NGINX package and defines UID/GID 101.
Compose explicitly runs the Nginx master and its worker as `101:101` and launches
the executable directly, bypassing the image's configuration hooks. Port 8080
requires no privileged bind. The PID and five module temp paths are under the
8 MiB `/tmp` tmpfs. The root filesystem and two bind mounts are read-only. The
service drops all capabilities, sets no-new-privileges and uses a 64 MiB
memory limit, no additional swap, half a CPU and 32 PIDs.
[Upstream Dockerfile](https://github.com/nginx/docker-nginx-unprivileged/blob/main/stable/alpine-slim/Dockerfile)

## HTTP and filesystem boundary

The project bridge publishes TCP `127.0.0.1:7300` to container port 8080. The
complete configuration loads a single virtual host. Only `GET` and `HEAD` on
`/` and `/index.html` can read the same static file. Query strings have no effect
on file selection. The original request path is checked before Nginx can route
a normalized alias. Other paths receive a generic 404, and other methods on the
report paths receive a generic 403.

The document root follows the publisher's relative `current` symlink. Nginx
blocks symlinks below that root and keeps its open-file cache off so new
requests can see the next atomic promotion. Only the dedicated site tree and
the complete Nginx configuration file are bind-mounted. Both bind sources must
already exist. The QEP account controls what is published through `current`.

Responses use `Cache-Control: no-store`, `nosniff`, no referrer and frame
denial. The HTTP CSP preserves the report's existing inline scripts and styles
and its embedded `data:` and `blob:` resources. The header also denies base URLs,
form submission and framing. Nginx serves the promoted HTML bytes directly.
Directory listings, request access logs and Nginx version banners are disabled.

## Static checks

Run from the QEP repository root. Compose's `config` command validates the model
without a Docker daemon. Hosted QEP CI covers the model assertions through
`npm test` using Node and the locked YAML parser.

```bash
npm run build
npm run typecheck
npm run lint
npm test
node --test test/report-hosting.test.js
docker compose --env-file /dev/null --project-name qep-report-hosting \
  --file deploy/report-hosting/compose.yaml config --quiet
git diff --check
```

## Owner deployment prerequisites and runtime checks

**Pending owner execution on Ubuntu.** Use a local Linux Docker Engine 28.0.0 or
newer with the Compose plugin and standard bridge port-publishing settings.
Confirm that only this service joins the project bridge, direct routing to that
bridge is disabled, and TCP port 7300 is available on IPv4 loopback. Older
Docker releases can expose loopback-published ports to hosts on the same L2
network. [Docker port-publishing behavior](https://docs.docker.com/engine/network/port-publishing/)

Provision the dedicated site root under the QEP owner with no nested mounts.
The runtime UID must be able to traverse the mounted root. Owner-controlled
mode `0711` supplies search access without granting directory listing. QEP
creates the release directories as `0755` and the HTML as `0444`. The mounted
`nginx.conf` must be readable by the container user. Use the approved Run IDs
with `qe site verify` before starting the service.
[Promotion and verification commands](allure3-runbook.md#0451-static-site-promotion)

Use Bash in the QEP repository root on the Ubuntu host. Use the same explicit
project and file for every Compose command.

```bash
set -euo pipefail
dc() {
  docker compose --env-file /dev/null --project-name qep-report-hosting \
    --file "$PWD/deploy/report-hosting/compose.yaml" "$@"
}
docker version --format '{{.Server.Version}}'
docker compose version
dc config --quiet
dc config --images
dc pull nginx
dc run --rm --no-deps -T --entrypoint nginx nginx -t -v
```

Expect `nginx/1.30.8` and a successful config test. Check missing-source
rejection with a temporary copy of the resolved model. The test uses the
already pulled digest and a deliberately absent path in a temporary directory.

```bash
(
  fixture=$(mktemp -d)
  trap 'rm -r -- "$fixture"' EXIT
  dc config --format json | node -e '
    const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const site = config.services.nginx.volumes.find(m => m.target === "/srv/qep-public");
    site.source = process.argv[1];
    process.stdout.write(JSON.stringify(config));
  ' "$fixture/missing" > "$fixture/compose.json"
  if docker compose --env-file /dev/null --project-name qep-report-hosting \
      --file "$fixture/compose.json" run --rm --no-deps -T --pull never \
      --entrypoint nginx nginx -t > "$fixture/result" 2>&1; then
    printf '%s\n' 'Unexpected success for missing bind source' >&2
    exit 1
  fi
  grep -F 'bind source path does not exist' "$fixture/result" | grep -F "$fixture/missing"
  test ! -e "$fixture/missing"
)
```

Once preflight passes, start just the report service and check its isolation.

```bash
dc up --detach --no-deps --pull never nginx
test "$(dc port nginx 8080)" = '127.0.0.1:7300'
cid=$(dc ps -q nginx)
docker inspect --format '{{json .HostConfig.PortBindings}}' "$cid"
docker inspect --format 'project={{index .Config.Labels "com.docker.compose.project"}} root_read_only={{.HostConfig.ReadonlyRootfs}} privileged={{.HostConfig.Privileged}} network={{.HostConfig.NetworkMode}}' "$cid"
docker inspect --format '{{range .Mounts}}{{println .Destination .RW}}{{end}}' "$cid"
dc exec -T nginx sh -e <<'SH'
test "$(id -u):$(id -g)" = 101:101
test -r /srv/qep-public/current/index.html
awk '
  /^Uid:/ { uid = ($2 == 101 && $3 == 101 && $4 == 101 && $5 == 101) }
  /^Gid:/ { gid = ($2 == 101 && $3 == 101 && $4 == 101 && $5 == 101) }
  /^Cap(Eff|Prm|Bnd):/ { dropped += ($2 ~ /^0+$/) }
  /^NoNewPrivs:/ { nnp = ($2 == 1) }
  END { exit !(uid && gid && dropped == 3 && nnp) }
' /proc/1/status
ps -o pid,user,group,args
awk '$2 == "/tmp" { print }' /proc/mounts
SH
```

Expect one port binding, project `qep-report-hosting`, network
`qep-report-hosting_default`, `root_read_only=true`, and `privileged=false`.
The two bind destinations should both show `false` in the writable column.
Nginx should be PID 1, and both master and worker should run as `nginx:nginx`
(101:101). The `/tmp` mount should be writable tmpfs with `noexec,nosuid,nodev`.

```bash
(
  probe=$(mktemp -d)
  trap 'rm -r -- "$probe"' EXIT
  http() { curl --noproxy '*' --silent --show-error --path-as-is "$@"; }
  base=http://127.0.0.1:7300
  index=/home/clu/infra/qep-report-site/current/index.html
  for path in / /index.html '/index.html?probe=1'; do
    http --fail "$base$path" | cmp - "$index"
    http --fail --head "$base$path" > "$probe/headers"
    grep -Eiq '^HTTP/1\.[01] 200([[:space:]]|$)' "$probe/headers"
    grep -Eiq '^Content-Type: text/html([;[:space:]]|$)' "$probe/headers"
    grep -Eiq '^Cache-Control: no-store[[:space:]]*$' "$probe/headers"
    grep -Eiq '^Server: nginx[[:space:]]*$' "$probe/headers"
    grep -Eiq '^Content-Security-Policy: ' "$probe/headers"
  done
  http "$base/not-found" -o "$probe/generic"
  for path in /report-manifest.json /summary.json /test-results.json /history.jsonl \
    /.local/reports/index.html /current/index.html /releases/example/index.html \
    /data/example //index.html /./index.html /%69ndex.html /index.html/; do
    test "$(http -o "$probe/body" -w '%{http_code}' "$base$path")" = 404
    cmp "$probe/generic" "$probe/body"
  done
  for path in / /index.html; do
    test "$(http -X POST -o /dev/null -w '%{http_code}' "$base$path")" = 403
  done
)
```

Load the loopback URL in a browser on the host and verify that the report
renders and its navigation works under the HTTP CSP. If any runtime check fails,
stop the report service with `dc stop nginx`. To revert report content, use the
previous report's explicit Run IDs with the promotion workflow.
