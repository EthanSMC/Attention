# Isolated public reader — disabled pending acceptance

The Fetcher entrypoint supplies **no renderer and no admission coordinator by default**.
It serves static `/v1/read`; a document requiring rendering returns
`browser_backend_unavailable` with `pause`. Explicit operator configuration and the
acceptance attestation below are required to enable the isolated renderer.
This repository has no local Docker, Podman, nerdctl, runc, or crun runtime; the image,
Chromium sandbox, seccomp compatibility, direct network isolation, resource ceilings,
dynamic JavaScript execution, and physical cleanup have **not been accepted**.
Unit tests of protocol, broker, launcher, and controlled runner seams are not that gate.

## Operator deployment contract

Use a dedicated trusted launcher host/process, outside Web and DB. The launcher needs
an operator-controlled OCI runtime; the renderer must never receive its socket.
Build from the repository root with `apps/reader-browser/Dockerfile`, using a reviewed
base image digest in `NODE_IMAGE`. Build installs the exact locked Playwright 1.62.0
and matching Chromium assets. No browser runtime is installed on the user's host.
Review/scan the resulting image and select its immutable local `name@sha256:...` digest.
The launcher uses `--pull=never`; request input cannot choose runtime, image, command,
environment, coordinator destination, seccomp profile, mounts, or browser flags.

Install the reviewed `seccomp.json` at a root-controlled `/etc/attention/*.json` path.
It defaults to denial, permits only AF_UNIX sockets, and allows Chromium's namespace
and seccomp sandbox setup; compatibility must be tested on the deployment kernel.
Never respond to sandbox failure by adding `--no-sandbox`, `SYS_ADMIN`, privileged
mode, host network/IPC, an unrestricted profile, or host mounts.

`buildLaunchArgs` fixes network=none, private IPC, uid/gid 10001, read-only root,
all capabilities dropped, no-new-privileges, 128 PIDs, 1 CPU, 2 GiB memory (no swap),
192 MiB tmpfs plus 64 MiB private shm (256 MiB total temporary storage). The only
renderer environment is HOME/TMPDIR under tmpfs, NODE_ENV, and an accidental-host-run
guard. The child receives JSONL stdin/stdout and discarded stderr, without business
environment, credentials, host user directories, mounts, Docker socket, or exposed
browser ports. Chromium's own sandbox stays enabled.

The configuration's `isolationVerified: true` is a **trusted operator attestation**
after the gate below, not automatic evidence. `createIsolatedBrowserReader` also
checks the fixed runtime executable and default-deny profile. Task 3 supplies a
fixed operator-configured coordinator client and production startup wiring; there is
no request-supplied URL or implicit in-process database access in Fetcher.

## Internal protocol and budgets

Frames are strict JSONL: start; resource; resource_result/resource_error; complete/failed.
Each result includes `{id,status,contentType,bodyBase64,finalUrl}`. The additive
`finalUrl` is required: the runner uses a container-internal CDP session with Fetch
request-stage interception, fulfills a bodyless 302 for a redirected resource, and
brokers the ensuing `Fetch.requestPaused` event too. This applies to documents,
modules and CSS, retaining browser URL bases without forwarding upstream headers.
Both fetches count; redirects never reset budgets. Playwright's HTTP route API is
not installed: in the locked 1.62.0 implementation it automatically continues
redirect hops, which would bypass the broker and fail inside the networkless
container. The CDP session is local to the runner's page, has no exposed port or
model-facing capability, and never issues Fetch.continueRequest. Authentication is
cancelled. Interception stays enabled until the page context is closed.

The parent uses safeFetch's URL, sensitive-query, all-DNS-answer, pinned-address,
actual-peer, per-redirect, and HTTPS downgrade checks for each GET. Cookies,
Authorization, upstream headers, and page-selected credentials are never forwarded.
Only document/script/stylesheet/fetch/xhr GETs are relayed. Images, fonts, media,
POST, popups, child frames, downloads, WebSockets and service workers are blocked.
Resources are capped at 100, four concurrent, 2 MiB each, and 20 MiB cumulative bytes;
concurrent reads reserve from the same remaining budget. JSONL in both directions
shares a separate 20 MiB cap, including base64 overhead and final snapshot. Frames
are at most 3 MiB, HTML snapshots at most 2 MiB UTF-8, rendering at most 60 seconds,
and the authenticated request (including body consumption) at most 90 seconds.
The stricter wire cap may end a read before 20 MiB binary bytes are reached.
Pipe error events and write-callback failures are caught across renderer launch,
reading and stream destruction. Cleanup is awaited before listeners are removed;
confirmed cleanup returns a typed backend dependency failure, while uncertain
cleanup retains the shared slot.

## Shared admission / Task 3 boundary

The authenticated `/v1/read` accepts strict ReadRequest and a separate server-only
`X-Reader-Admission` reference. Missing provider, reference, backend or claim fails
closed. BrowserAdmission.consume atomically claims one of **two shared physical
browser slots** and consumes the one-shot reference bound to request_ref,
attempt_ref and SHA-256 of the normalized source URL. The raw URL stays transient.
It also persists the server-generated `renderer_ref` (`attention-reader-<uuid>`),
which is the exact container name; the same claim must bind cleanup/release.
References cannot be reusable signed tokens. Process-local capacity is not global
browser admission. Account limits (1 active read, 6/minute) and one read per attempt
belong to the server coordinator, separately from Fetcher's local overload limit.

consume returns a lease AbortSignal and async release. Its signal aborts on expiry,
revocation or coordinator loss. The fixed coordinator endpoint, authentication,
bounded HTTP protocol and lease polling are wired by the Fetcher startup configuration below.
Release occurs only after the renderer and resource broker finish cleanup.
RendererCleanupError retains the slot and returns unavailable/pause. Orphaned slots
stay quarantined; lease TTL **does not prove container death**. A trusted operator
or reconciler must confirm removal of that exact name or fence the launcher host
before reassigning its slot. General read/account leases may expire independently.

### Operator configuration and default gate

The default is disabled. This implementation has **not** passed the real OCI
acceptance below. Do not set the attestation flag until the intended runtime,
immutable image and profile have passed it and the evidence has been recorded.
No environment, running service, account or deployment is changed by this code.

Fetcher accepts these server startup settings (never fields of `/v1/read`):

| Setting | Required value when enabling after acceptance |
| --- | --- |
| `ATTENTION_READER_BACKEND` | `isolated_oci`; absent or `disabled` leaves the backend off |
| `ATTENTION_READER_ISOLATION_VERIFIED` | literal `true`, operator attestation after real OCI acceptance |
| `ATTENTION_READER_OCI_RUNTIME` | `/usr/bin/docker` or `/usr/bin/podman` |
| `ATTENTION_READER_OCI_IMAGE` | approved immutable `name@sha256:<64 lowercase hex>` |
| `ATTENTION_READER_SECCOMP_PATH` | approved `/etc/attention/*.json` deny-by-default profile |
| `ATTENTION_READER_COORDINATOR_ORIGIN` | fixed HTTPS Web origin, no credentials, query or path |
| `ATTENTION_READER_COORDINATOR_SECRET` | independent server secret of 32–256 characters, same value on Web and Fetcher |

The profile and runtime must exist; a missing/unattested configuration does not
fall back to a host browser. Existing `FETCHER_BASE_URL` / `FETCHER_SHARED_SECRET`
continue authenticating Web → Fetcher separately. Web needs migration
`0038_source_read_coordination`; its existing non-owner `attention_web_runtime`
role has account-scoped coordination access and only the restricted function for
physical slots. Do not grant direct browser-slot writes to the Web runtime role.

### Internal protocol and revocation bounds

Fetcher sends authenticated POSTs to the fixed paths
`/api/internal/source-reader/consume`, `/status`, and `/release` (the latter two
share the same prefix). Each request is limited to 4 KiB and each client call to
one second, with redirects rejected and responses limited to 4 KiB.
The consume body is `{reference, request_ref, attempt_ref, source_fingerprint,
renderer_ref}`. Status and release additionally carry the returned UUID `claim`.
No account, source URL, credentials or body text is accepted in these requests.
Consume returns `{claim}`; status returns `{active:true}`; confirmed release returns
`{released:true}`. A full pair of currently authorized slots returns HTTP 429 with
`{code:"rate_limited",retry_after_ms:1000}`. Stale, consumed, mismatched or
quarantined claims fail closed (409); configuration/authentication or coordinator
failure also fails closed. A quarantine is never disguised as ordinary capacity.

The original Web/MCP request owns its real credential revalidation closure. It
checks the current principal and Core-owned collection/source every 500 ms,
with each heartbeat check bounded to one second. Only a successful check renews
a **DB-clock authorization deadline at most two seconds away**, bounded by the
90-second account lease. The original principal resolver is not memoized and no
token is stored in the coordination database. Other Web processes recheck the
current Core identity on consume and status and require that fresh delegation.
Fetcher polls every 500 ms, aborting on stale status, denial, timeout or loss.
After owner loss, revocation detection is bounded by the two-second delegation
plus the next 500 ms poll and up to one second HTTP timeout (then exact cleanup).
Each active read costs up to two principal/Core revalidations and coordination
updates per second; each active renderer adds up to two status checks per second.
An in-flight DB query may finish after cancellation, but it cannot restart the
stopped loop or renew an already released/replaced lease.

Every eligible user invocation consumes the account's DB-clock six-per-minute
budget **before cache/in-flight reuse**. A busy cross-process result still costs
one invocation. Static/browser switching and legacy fallback do not debit again;
internal heartbeats/admission calls are not user invocations. Each account has
one active source lease. Same-process duplicates share work; another process
receives bounded retry guidance. A duplicate cancellation ends only that wait;
owner cancellation/revocation conservatively ends the shared read. Each waiter
reauthorizes independently, and returned `request_ref` always matches that call.
The completed cache has one entry per account, a global 4 MiB serialized UTF-8
bound, and active 120-second eviction. Revocation/ineligibility discards cached
text. Source URLs, bodies and text never enter the coordination tables or audit.

### Web/MCP and legacy compatibility

MCP contract 1.7.0 exposes `attention_read_collection_source`; the session endpoint
is `POST /api/collections/[collectionId]/source-read`. Both require current Member
or Filter, owned eligible content and collection read permission. Model input
contains only collection ID, safe attempt reference and existing client context.
The owned strict ReadResult adds `collection_id` for Bridge correlation.
Configuration/rate preflight failures have truthful empty `attempts`; ready
results require real method evidence. Completed reads rejected by final permission
checks retain validated attempts but discard text/metadata. Indeterminate
post-dispatch failures use existing opaque error envelopes: `fetcher_unavailable`
(Web 503), `fetcher_timeout` (504), or `invalid_fetcher_response` (502).
These are reader-call failures, not proof that the entire MCP service is down.

Only an HTTP 404 on `/v1/read` enables the old `/v1/fetch` `mode:"metadata"`
compatibility read, within the same 90-second signal budget. It classifies the
legacy target status/body using the shared classifier and reports one static
attempt; no browser admission header or browser claim is sent for fallback.
No fallback occurs on 403, 500, malformed results or a current reader's failure.
The pure `@attention/fetcher/url-policy` export validates URL shape/public-address
policy and downgrade rules without loading a server, launcher or network client.
Legacy DNS/connected-peer enforcement is attested by authenticated Fetcher,
not claimed to run again inside Web.

### Quarantined-slot recovery

There is deliberately no automatic slot reset or TTL-based recovery. An operator
with access to the exact launcher host first reads the occupied slot's `reference`,
`claim` and `renderer_ref` from `source_read_browser_slots` using a privileged
maintenance connection. Record that tuple and confirm removal of **that exact**
container (`docker rm --force attention-reader-<recorded UUID>` or the configured
Podman equivalent), then confirm the container is absent; alternatively fence the
launcher host so the process cannot continue. If cleanup/host identity is uncertain,
leave the slot occupied and investigate. After proof, call the authenticated release
endpoint with the matching tuple and original request/attempt/source references,
or the restricted `source_read_browser('release', reference, NULL, NULL, NULL,
renderer_ref, claim)` function using that maintenance connection. It conditionally
clears only the matching tuple. Never clear all slots or reassign on lease expiry.

## Required acceptance gate (not executed here)

1. Build and inspect the exact image/profile on the intended Linux runtime/kernel.
   Verify uid 10001, zero capabilities, no-new-privileges, seccomp, read-only root,
   no host sockets/mounts, private IPC, network namespace and all cgroup/tmpfs limits.
2. Run a synthetic HTML shell plus controlled JavaScript article via the real broker
   and JSONL runner. Assert real final article extraction, final URL, one static then
   one browser attempt, and cleanup. Exercise redirected document/script/CSS relative
   bases on the actual browser, not only synthetic CDP events. The parent still
   forwards only Content-Type and validated redirect destination; cross-origin
   module/fetch responses requiring CORS headers may fail. Worker targets and
   out-of-process child frames are not independently brokered; container network
   isolation remains mandatory and unsupported targets must fail closed.
3. Prove direct container sockets cannot reach public, private, loopback host, or
   metadata destinations. Test broker DNS rebinding, redirect-to-private, POST,
   WebSocket, service worker, popup and download denial using controlled targets.
4. Force frame/byte/resource/PID/memory/disk/time limits and cancellation. Confirm
   exact container death and broker drain before release. Disconnect the runtime
   and kill the launcher: shared slots must remain quarantined until trusted cleanup.
5. Exercise the wired Task 3 authenticated coordinator client on the intended hosts,
   prove cross-process one-shot claims/global two slots with actual containers,
   then record the immutable image/profile/kernel evidence
   before operator attestation or enabling a production renderer.

API references: [Playwright Docker](https://playwright.dev/docs/docker) and
[Playwright network interception](https://playwright.dev/docs/network),
[CDPSession](https://playwright.dev/docs/api/class-cdpsession), and
[CDP Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/). Their generic
container examples do not override this contract's stronger isolation requirements.
