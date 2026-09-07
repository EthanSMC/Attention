# Isolated public reader — disabled pending acceptance

The Fetcher entrypoint currently supplies **no renderer and no admission coordinator**.
It serves static `/v1/read`; a document requiring rendering returns
`browser_backend_unavailable` with `pause`. No environment variable enables the renderer.
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
checks the fixed runtime executable and default-deny profile. Task 3 must add a
fixed operator-configured coordinator client and production startup wiring; there is
no request-supplied URL or implicit in-process database access in Fetcher.

## Internal protocol and budgets

Frames are strict JSONL: start; resource; resource_result/resource_error; complete/failed.
Each result includes `{id,status,contentType,bodyBase64,finalUrl}`. The additive
`finalUrl` is required: the runner synthesizes a bodyless 302 for any redirected
resource, including documents, modules, and CSS, then re-requests through the same
broker. This preserves relative URL bases without forwarding upstream headers.
Both fetches count; redirects never reset budgets.

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
bounded HTTP protocol and lease polling are Task 3 production integration work.
Release occurs only after the renderer and resource broker finish cleanup.
RendererCleanupError retains the slot and returns unavailable/pause. Orphaned slots
stay quarantined; lease TTL **does not prove container death**. A trusted operator
or reconciler must confirm removal of that exact name or fence the launcher host
before reassigning its slot. General read/account leases may expire independently.

## Required acceptance gate (not executed here)

1. Build and inspect the exact image/profile on the intended Linux runtime/kernel.
   Verify uid 10001, zero capabilities, no-new-privileges, seccomp, read-only root,
   no host sockets/mounts, private IPC, network namespace and all cgroup/tmpfs limits.
2. Run a synthetic HTML shell plus controlled JavaScript article via the real broker
   and JSONL runner. Assert real final article extraction, final URL, one static then
   one browser attempt, and cleanup. Exercise redirected document/script/CSS relative
   bases on the actual browser, not only the route seam.
3. Prove direct container sockets cannot reach public, private, loopback host, or
   metadata destinations. Test broker DNS rebinding, redirect-to-private, POST,
   WebSocket, service worker, popup and download denial using controlled targets.
4. Force frame/byte/resource/PID/memory/disk/time limits and cancellation. Confirm
   exact container death and broker drain before release. Disconnect the runtime
   and kill the launcher: shared slots must remain quarantined until trusted cleanup.
5. Wire the Task 3 authenticated coordinator client, prove cross-process one-shot
   claims/global two slots, then record the immutable image/profile/kernel evidence
   before operator attestation or enabling a production renderer.

API references: [Playwright Docker](https://playwright.dev/docs/docker) and
[Playwright network interception](https://playwright.dev/docs/network). Their generic
container examples do not override this contract's stronger isolation requirements.
