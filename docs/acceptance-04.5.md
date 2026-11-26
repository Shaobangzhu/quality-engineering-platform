# INFRA-04.5 Final Acceptance Report

**Final decision — PASS / CLOSED.** Accepted on 2026-11-26 UTC. INFRA-04.6 is outside this review.

## Initial review — 2026-11-26 UTC

The initial review on Ubuntu 26.04.1 recorded **NO-GO** while Docker daemon inspection, database lifecycle comparison, and Mac Remote-SSH verification were pending. The Ubuntu collector resolved the Docker and controlled-restart checks, and the Mac operator verified access and report integrity through the VS Code Remote-SSH forward.

## A. GitHub implementation

GitHub confirmed all three PRs merged to `main`. The review started with a clean `docs/infra-04.5.4-acceptance` checkout at `945627fbcf9a8cd4aecfe55cce48b02d2d7d04a5`, matching GitHub's `main`.

| Milestone | Implementation | Merge commit |
| --- | --- | --- |
| 04.5.1 | Verified static report promotion | `5a62893` [PR #21](https://github.com/Shaobangzhu/quality-engineering-platform/pull/21) |
| 04.5.2 | Read-only Nginx hosting on loopback | `49bd8d8` [PR #22](https://github.com/Shaobangzhu/quality-engineering-platform/pull/22) |
| 04.5.3 | Hosting smoke checks and rollback runbook | `945627f` [PR #23](https://github.com/Shaobangzhu/quality-engineering-platform/pull/23) |

QEP CI passed on the `main` push at that SHA and completed at 2026-11-26 01:39:45 UTC. The `validate` job passed build, typecheck, lint, the Contract v1 and adapter fixtures, the standard QEP suite, and the standalone Allure generator fixture. [Workflow run 45737156043](https://github.com/Shaobangzhu/quality-engineering-platform/actions/runs/45737156043) · [Validate job](https://github.com/Shaobangzhu/quality-engineering-platform/actions/runs/45737156043/job/139633057370)

## B. Private report provenance

Read-only `qe report verify` returned `verified` for the original INFRA-04.4 report `4a01f5da12c7404e80d4b1317eb312685e16f9cc85387f665d29828e264df6ee`. It verified the schema-v2 manifest and successful launch under `qep-audited-pass-v1` with Allure 3.33.0. The private history records one accepted launch and a null previous report ID.

| Suite | Verified Run ID | Passed |
| --- | --- | ---: |
| DGI backend | `af9dbaab-a9ba-40d3-b285-3762d8a2b558` | 189 |
| DGI frontend | `4f258528-22f4-4b99-9f38-5c65d282da5b` | 257 |
| CLU unit | `01ca49e4-dc10-4317-8362-99ec59dcf372` | 83 |
| **Total** | | **529** |

Each retained QEP run recorded `PASS`, child exit code 0 and collection state `COMPLETE`. The verifier returned zero failed, broken, skipped or unknown cases. [INFRA-04.4 closure](acceptance-04.4.md#infra-044--closed--pass)

## C. Promotion integrity

The retained private `promotion-authorized` receipt dated 2026-11-26 01:48:24 UTC recorded `previous: null`, the three reviewed Run IDs, the report ID, the manifest digest and the HTML digest. The receipt precedes activation. The live tree and read-only `qe site verify` independently confirmed the recorded release is active. `qe site plan` returned `reuse` for that selection.

The complete deployment tree at `/home/clu/infra/qep-report-site` contained `releases/`, one approved release directory containing one regular `0444` file named `index.html`, and a relative `current` symlink pointing to that release. The site root was `0711` and both release directories were `0755`.

The QEP-verified source HTML, deployed `current/index.html`, Ubuntu GET response bodies for `/`, `/index.html` and `/index.html?probe=1`, and the Mac operator's downloaded HTML all matched the same SHA-256. Ubuntu measured 3,104,756 bytes for the source, deployed file and each response body.

```text
SHA-256  d54c2d237e6c121e364729ea1b941bdfe8e6d1a394e76c8a474c0706ae630ad6
```

## D. Ubuntu Docker isolation

The live Nginx master and worker shared a Docker cgroup and each ran as UID/GID `101:101`. Both processes had zero effective, permitted and bounding capabilities and `NoNewPrivs: 1`. The master process's mount namespace showed a read-only container root and a writable `/tmp` tmpfs with `noexec,nosuid,nodev`.

The only deployment bind sources were the dedicated report tree at `/srv/qep-public` and the single approved Nginx configuration file at `/etc/nginx/nginx.conf`. Both were read-only. The complete live mount inventory showed no Docker socket, raw run, private manifest, audit or receipt file, or QEP source directory mount. [Approved Compose configuration](../deploy/report-hosting/compose.yaml)

The follow-up collector used operator access to confirm the `qep-report-hosting` Compose project and `nginx` service before and after the controlled restart. Both Docker inspections confirmed user `101:101`, a read-only root filesystem, the same two read-only bind mounts, all capabilities dropped, `no-new-privileges:true`, and privileged mode disabled. No devices or inherited volumes were configured.

## E. Ubuntu port exposure and bridge routing

Before and after the restart, Compose and the configured and active Docker port mappings (`HostConfig.PortBindings` and `NetworkSettings.Ports`) all showed a single publication from `127.0.0.1:7300` to `8080/tcp` on the approved Nginx container. In each snapshot, `ss` showed a single TCP listener on `127.0.0.1:7300`. The initial Ubuntu checks also found that port 7300 refused local connections to each non-loopback IPv4 address.

On Docker Engine 29.9.3, `qep-report-hosting_default` was the service's only network and the Nginx container was the bridge's sole member before and after the restart. Both gateway modes were the default `nat`, IPv6 was disabled, and no trusted host interfaces were configured. The collector found no direct-routing flag or daemon configuration file and recorded effective `allow-direct-routing` as `false`. It recorded no `iptables` or `ip6tables` overrides. These settings confirmed the approved bridge routing policy. [Ubuntu preflight and port checks](hosting-04.5-runbook.md#ubuntu-host-acceptance)

## F. Ubuntu HTTP and browser smoke tests

The initial repository hosting smoke returned `passed`. A separate HTTP check returned `200` and `text/html` for GET and HEAD on both report URLs. Private metadata, audit and source-style paths, direct release URLs and unsupported paths returned the same generic `404`. The repository check also verified `403` for bodyless POST, PUT, PATCH and DELETE on the two report URLs, the required response security headers, and identical published and served digests after probing.

Ubuntu Chromium 159.0.8154.6 displayed the 529-pass overview and three suite counts and opened a passing case from each suite. It recorded zero uncaught page errors, failed browser requests or off-origin request attempts. Chromium logged one console error and corresponding CSP violation when it blocked setting the document base URL under `base-uri 'none'`. The reviewed views rendered with the restriction in force.

The Ubuntu collector passed its controlled recheck at 02:14 UTC on 2026-11-26. Docker recorded a new start time for the same Nginx container. The post-restart hosting smoke returned `passed` for the approved report ID, 3,104,756 bytes and the SHA-256 recorded above.

## G. Mac operator evidence

The Mac operator opened `http://127.0.0.1:7300/` through the VS Code Remote-SSH loopback forward and saw 529/529 passed. The operator expanded `dgi-frontend-unit` and opened case `a89ee327e463`, which showed status `Passed`. The downloaded HTML matched the approved SHA-256. From the Mac, the Ubuntu Tailscale address accepted TCP 22 and refused TCP 7300. [Mac acceptance procedure](hosting-04.5-runbook.md#mac-access-through-vs-code-remote-ssh)

## H. Source and database integrity

The retained INFRA-04.4 protection inventory matched all 74 recorded paths, including 72 file SHA-256 digests, modes, and timestamps. The protected files included all five original report files and the historical owner acceptance evidence. The nine original run artifact digests also matched the INFRA-04.3 closure. The tracked prior acceptance records matched the starting checkout. Review used the retained DGI and CLU artifacts.

The Ubuntu collector captured all five database containers immediately before and after the controlled Nginx restart. The two snapshots were byte-for-byte identical across container names, IDs, states, start and finish timestamps, and restart counts. All five were `running` with restart counts of `0` in both snapshots. This verifies database container continuity across the controlled restart. The original deployment lacked a pre-start database snapshot, leaving database continuity during the initial start unverified.

## I. Rollback readiness

Reviewed the runbook for missing or damaged releases, unexpected report `404`, port conflicts, Docker socket denial, missing temp directories, hash mismatches and stale browser reports. The manual rollback procedure requires a previously accepted report ID, HTML digest and Run IDs, validates the plan, atomically switches `current` through the publisher and rechecks the restored HTTP digest and DB state. Synthetic rollback coverage passed in QEP CI, including restoration of a prior selection byte for byte. The suite also covered rejected and interrupted promotions and concurrent publishers. [Failure diagnosis](hosting-04.5-runbook.md#diagnosis) · [Manual rollback](hosting-04.5-runbook.md#manual-rollback-to-a-previously-accepted-release)

Live rollback is **N/A** because only the initial release existed and the promotion receipt recorded no previous selection.

## J. Evidence retention

Screenshots, raw logs, and private audit records are retained under `.local`.
