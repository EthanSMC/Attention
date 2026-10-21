# Local validation — 2026-10-19

This backend remains opt-in. No production configuration, database records,
published images, historical CLI artifacts or main-checkout work in progress
were changed.

## Software and build

- Official Docker Desktop 4.95.0 (242831), Apple Silicon; DMG SHA256 checked,
  Apple code signature verified, Gatekeeper accepted Docker Inc's notarized app.
- Docker Engine 29.8.2, Linux arm64. Current-user CLI/socket mode;
  `AutoStart=false`, `EnableDefaultDockerSocket=false`, `RequireVmnetd=false`.
- Unmodified Agent-Reach 1.5.0 at commit
  `f65526cbaaad3879473acc1ba6dbefd195caf2be`, built with the pinned official
  Python 3.13.16 image and six hash-locked build dependencies.
- Fifteen hash-locked runtime dependencies plus the resulting upstream wheel
  installed offline in the container. No host Python installation, upstream
  installer/doctor, credentials, host mounts or image publication.
- Actual isolated import returned version `1.5.0` and the callable method from
  `agent_reach.channels.web`. Exact build hashes/image ID: [provenance](./build-provenance.json).

## Checks completed

- 12 TypeScript suites: **210 passed**. The opt-in live suite's two tests are
  skipped during this offline run; they are counted separately below.
- Python adapter tests: **21 passed**, including non-public/fake-IP peer refusal.
- TypeScript checking of changed process/runtime tests and the actual Core
  dependency graph: passed. This was a scoped check, not the full web build.
- Actual production process executor, compiled without changing its behavior,
  ran an owned stdlib-only fixture through real Docker. It confirmed uid/gid
  65532, read-only root, writable bounded tmpfs, no effective capabilities,
  no-new-privileges, 512 MiB cgroup memory, 1 CPU, 64 pids and no Docker socket.
- Actual audit-hook requests rejected local HTTP/redirect destinations,
  private sockets, non-Jina DNS and process creation before access. This is
  enforcement of the reviewed Python path, not a general native-code firewall.
- Real abort and timeout returned in approximately 1.7 seconds including
  cleanup. Output exceeding 2 MiB was rejected. All four named fixture
  containers were independently confirmed absent; no containers remained
  after the public checks either.

The first regression run encountered the same intermittent local filesystem
behavior seen during setup: an installed CommonJS module loaded as an empty
object. Reading its existing bytes warmed it without modifying or reinstalling
the dependency; the subsequent full scoped run passed all 210 tests.

## Real public-read acceptance: passed

The opt-in live suite executed the real Attention Core gateway, configured
reader, Docker process and upstream. Database-backed authority/admission used
synthetic records; real database exports were disabled. After the approved
domain-only network compatibility change, both live assertions passed:

- `https://www.python.org/doc/essays/blurb/`: `ready`, `agent_reach`, 12,000
  temporary evidence characters (the configured limit), approximately 3.2 seconds.
- `https://example.com/`: `failed / evidence_insufficient`, `agent_reach`,
  approximately 1.1 seconds. The short page was not accepted as article evidence.

The first attempt for each URL had correctly failed closed before HTTP because
Shadowrocket's TUN DNS returned `198.18.0.106` and `::ffff:0:c612:6a`. The user
then explicitly approved adding only `r.jina.ai` to the current `default.conf`
General / Always Real IP list. The native UI session recorded an empty original
list, saved the single entry and reopened it to confirm. No other setting or
additional tunnel reconnect was used. Roll back by removing only that new entry
and applying the profile normally; no node credentials or whole-profile export
are required.

Public-looking DNS records were not treated as proof of the destination. An
HTTP-free preflight in the exact runtime image loaded 150 existing CA roots,
retained the worker audit hook, and verified the IPv4 TLS 1.3 connection against
`r.jina.ai` with certificate and hostname checks enabled. The IPv6 address had
no container route; ordinary standard-library address fallback needed no policy
change. There was no certificate failure in the actual image. A prior host
Python probe had zero CA roots and was not used to establish target identity.

No public-address allowlist, TLS verification, proxy credential handling,
container isolation or production setting was weakened. Both real reads used
the actual production launcher and unmodified upstream WebChannel, with no
Fetcher fallback. The worker used no Jina key or account.

Each URL now has two reserved attempts in the durable record, including the
initial pre-HTTP failure. The approved budget is exhausted; do not reset the
record or silently retry again. Offline tests still skip this opt-in suite.
After the final read, zero containers remained and Docker Desktop was stopped
successfully, retaining the local immutable image.

The native Docker UI inspection service timed out; it was not possible to verify
or change all optional telemetry/feature preferences through the interface.
The verified user-mode settings above are recorded separately from that limitation.

Not run: database/RLS integration, full web build/typecheck, actual platform
accounts (WeChat/Xiaohongshu/Douyin), real model calls, production activation,
CLI distribution or induced daemon-outage races. Existing unit tests still
cover permission revocation, tenant/cache separation and uncertain cleanup.
