# Agent-Reach worker

This is a one-shot Attention adapter, not a fork or an alternative parser. It imports
`agent_reach.channels.web.WebChannel` and calls its unmodified `read(url)` method.
The component is fixed to Agent-Reach **v1.5.0**, commit
`f65526cbaaad3879473acc1ba6dbefd195caf2be`:

- [Reviewed upstream method](https://github.com/Panniantong/Agent-Reach/blob/f65526cbaaad3879473acc1ba6dbefd195caf2be/agent_reach/channels/web.py)
- [Dependency/build metadata](https://github.com/Panniantong/Agent-Reach/blob/f65526cbaaad3879473acc1ba6dbefd195caf2be/pyproject.toml)

The method sends the entire public source URL to **https://r.jina.ai**. There is
no hosted Agent-Reach API or stable unified read CLI. This specific Python method
is an integration contract that must be rechecked on upgrades. Agent-Reach remains
an independently versioned image dependency; no upstream source is copied here.

## Attention integration and enablement

Core's `collection-source-reader.ts` still derives the source from the authorized
collection; the model cannot submit an arbitrary URL. Its default read dependency
now selects this component only when server-only `ATTENTION_AGENT_REACH_IMAGE` is
set to a valid `repository@sha256:<64 lowercase hex>` reference or local immutable
`sha256:<64 lowercase hex>` image ID. Floating tags are rejected. An unset/empty value
keeps the existing Fetcher. An invalid nonempty value fails closed. A configured
component failure is returned through the existing recovery contract, without
silently invoking another reader. Only `collection.read_source` uses this switch;
URL resolution and the background enrichment worker retain their current paths.

The component consumes only a source URL and opaque request/attempt references.
It receives no account identifier or Core admission credential. Requests stay
inside the existing account-scoped authorization, rate limit, coordination/cache
and final revalidation flow. Results carry `agent_reach` as the read/extraction
method; rebuild and upgrade the CLI bridge from this source before enabling it
(historical bundles through 0.3.20 reject the new method). No old CLI release
artifact is overwritten by this integration.

The thin result adapter accepts the reviewed Jina text envelope, matches its source
against the authorized URL and preserves only the title and bounded Markdown body.
It rejects warnings, gate/error pages, short previews, list-only pages and text
without at least two distinct prose paragraphs/280 letters or numbers. This is
conservative and can reject valid short posts. At most 12,000 characters become
temporary evidence; no shared article state is updated by the reader. Provider
text remains untrusted data under the existing agent prompt and transient-evidence
handling. The returned `final_public_url` is the authorized request URL, not an
independently verified remote redirect destination.

This optional launcher requires an already authorized local Docker runtime and
preloaded approved image. It does not install Docker, pull images, grant daemon
access, configure credentials, or change production settings. Do not expose a
Docker socket to a service or alter its permissions merely to enable this backend;
that would be a separate deployment/security decision. See [VALIDATION.md](./VALIDATION.md)
for the actual local runtime/public-read checks and their scope.

## Protocol v1

Exactly one UTF-8 JSON request on stdin, followed by EOF; exactly one JSON response
on stdout. Input limit: 16 KiB; URL limit: 8 KiB; encoded response limit: 2 MiB,
including JSON escaping and the newline. Attention must impose its own lower text
limit when converting this output to a content result. No command-line source URL,
credentials, arbitrary options, runtime package selection, or extra fields.

```json
{"schema_version":1,"url":"https://example.com/article","source_kind":"generic_web","request_ref":"request:1","attempt_ref":"attempt:2"}
```

```json
{"schema_version":1,"request_ref":"request:1","attempt_ref":"attempt:2","upstream_version":"1.5.0","outcome":"ok","text":"Untrusted page text"}
```

Failures have `outcome: "failed"` and `code` instead of `text`. See `FAILURE_CODES`
in `worker.py` for the finite list. No raw exception, stack trace, URL or stderr is
returned. The version on a failure means the expected component contract; success
also requires matching installed distribution and imported module versions. A
digest-pinned image and its build provenance establish the precise upstream commit.
Unparseable requests use empty correlation references and must never be accepted
as a successful read. References must match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`.

`generic_web`, `wechat_official_article`, and `douyin` use WebChannel text only.
WeChat and Douyin have no specialized channel in this upstream version; this does
not promise login recovery, full articles or video transcription. Xiaohongshu
returns `reader_not_configured`, including URLs mislabeled as generic web, so its
`xsec_token` cannot be handed to Jina. Unknown source kinds also fail closed.

## Runtime boundaries

Attention retains collection ownership, account isolation, entitlement, source
revision, cancellation and late-result checks before and after the worker call.
No owner credentials, database URL, host environment, cookies, browser profile,
host filesystem mount or Docker socket may be passed into the worker. Content is
always untrusted data: never instructions or executable commands. A successful
transport response alone is not article evidence; Attention must check the text.

Use one disposable OCI container per attempt with a fixed local image ID or digest,
no pull-on-run, non-root uid/gid, read-only root, a bounded `/tmp` tmpfs, dropped
capabilities, no-new-privileges, pids/memory/CPU limits, and a parent timeout that
force-removes a hung container. No privileged mode, host network, host PID/IPC,
device mapping, host mounts, or inherited environment. The 35-second Python alarm
is additional defense; the parent must kill hung startup/native code as well.

The standard Python audit hook permits urllib requests only to HTTPS `r.jina.ai`
on port 443; restricts DNS lookup to that origin; rejects socket connections to
non-public addresses or other ports; and denies process creation. It constrains
the reviewed upstream urllib implementation, including redirects back toward the
local network. **An audit hook is not a sandbox for arbitrary Python/native code.**
Container isolation and a reviewed immutable image are required. An upstream
upgrade changing transports must fail compatibility tests and be reviewed; do not
silently relax this policy. The clean environment removes proxy/credential input.

On macOS the launcher uses the official
`/Applications/Docker.app/Contents/Resources/bin/docker` and the current OS user's
`~/.docker/run/docker.sock`; it does not require system CLI/socket installation.
On Linux it uses `docker` on a fixed search path and `unix:///var/run/docker.sock`.
The OS account home comes from `userInfo()`, not inherited `HOME`. Its CLI receives only a fixed executable
search path and fresh temporary `HOME`/`DOCKER_CONFIG`, so inherited Docker contexts,
registry credentials, remote daemon variables and proxies cannot select a different
runtime. The socket is used by the trusted launcher only and is never mounted in
the worker. A missing daemon/socket is a configuration failure; installing Docker,
changing socket permissions, or enabling a different daemon requires separate
approval. Killing the Docker CLI alone does not confirm the container has stopped;
the launcher must also confirm removal of its generated container name.

The launcher creates a stopped container before separately starting it with attached
stdin. A canceled or unconfirmed create is never started. Cleanup succeeds only
after confirmed removal or a successful absence check; an interrupted create that
could still finish later is reported as `agent_reach_cleanup_unconfirmed`, even if
the container is not visible yet. Such a late creation can leave a stopped object,
not a running upstream read. Actual cancellation, timeout, overflow and generated-name
cleanup have been checked against Docker Desktop; uncertain-create races remain
covered by deterministic process tests rather than an induced daemon outage.

Source URLs reject userinfo, sensitive query parameters, fragments, nonstandard
ports, obvious local addresses and ambiguous numeric hosts. They are not resolved
locally before being sent to Jina. Jina's source fetch and redirects occur remotely;
this path does not claim the old Fetcher's DNS pinning or original response/final
URL guarantees. Use only public URLs without signed/private access material.
Upstream `resp.read()` has no size limit; the container memory cap is mandatory,
since checking stdout only cannot bound that allocation.

If a local proxy resolves `r.jina.ai` to a non-public fake IP (for example
`198.18.0.0/15`), this policy deliberately rejects it. Use an approved network path
with real public DNS results to validate public reads; do not add the fake range
to the public-address allowlist or inherit host proxy credentials.

## Fixed build inputs

The local approved build used the unmodified upstream source archive, an official
Python **3.13.16-slim-bookworm** image pinned by digest, six locked build dependencies
and fifteen locked runtime dependencies. Versions, hashes, source URL, built wheel
and local image ID are recorded in [build-provenance.json](./build-provenance.json).
`requirements.in` records the original source declaration;
`build-dependencies.lock` and `requirements.lock` are the exact hash-checked inputs
for this Linux arm64/Python 3.13 build. The final runtime lock includes the locally
built Agent-Reach wheel, not the unrelated same-name PyPI release.

Source archives and wheels are ignored by Git. After the exact software sources,
versions and execution are approved, prepare a narrow local build context with:

1. `source.zip` from the recorded GitHub commit, checked against its archive SHA256.
2. `wheelhouse/` containing only the official PyPI wheels matching both locks.
3. `Dockerfile.build-wheel`, the source archive and build lock to construct/export
   the upstream wheel using `--network=none --pull=false --platform=linux/arm64` and
   the recorded `PYTHON_BASE=name@sha256:...`. No host installation is required.
4. Verify the exported wheel hash matches `requirements.lock`, put it in the
   wheelhouse, then build `Dockerfile` with the same flags/base and record the
   resulting `docker image inspect --format '{{.Id}}'` value.

The Dockerfile installs only from that local wheelhouse using `--no-index` and
`--require-hashes`; RUN steps have no network. Registry metadata/base pulls are
separate from these offline installation steps. Keep Docker CLI configuration
empty and target only the local daemon; do not use remote builders or push images.
Approval must cover installation and the limited validation run before execution. No automatic
`agent-reach install`, `setup`, `configure`, `doctor`, skill registration, browser
download, cookie extraction or credential setup is part of this component.

## Offline tests, upgrade and rollback

Run `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_worker.py` in this directory.
Tests execute only stdlib and this adapter, inject fake upstream modules and do not
contact websites. They cover protocol bounds, finite errors, credentials, platform
exclusions, network audit enforcement, environment cleaning and the import contract.
These tests alone do not establish that the real package imports or can read a live URL.

The opt-in `apps/web/src/server/agent-reach-live.test.ts` separately exercises the
actual Core gateway, configured reader, Docker transport and upstream. Only authority
records/admission are synthetic; database exports are disabled. It requires
`ATTENTION_AGENT_REACH_REAL_SMOKE=1`, a strict local `ATTENTION_AGENT_REACH_IMAGE` ID
and `ATTENTION_AGENT_REACH_LIVE_RECORD` pointing to a durable JSON count file.
Only the Python introduction and example.com are allowed, with at most two attempts
per URL and a five-second pause even after assertion failure. Normal test runs skip
this suite and never contact those services. Do not reset a current approval's count
file to obtain additional attempts.

For an upgrade, review the fixed upstream method and import side effects, bump the
version/commit, regenerate reviewed exact dependency locks and build a new immutable
image. Run these offline tests, parent contract/regression tests, then the approved
real import and public synthetic read checks with no credentials or business data.
Also test actual container timeout/kill, memory limit, blocked private DNS/redirects,
and unavailable upstream behavior. Keep the previous image and lock/provenance.
Switch only the explicitly configured component image after those checks. Roll back
by restoring the previous image or disabling the optional backend; do not patch the
upstream package or modify existing collection records. No automatic upgrades,
scheduled tasks or production deployment are configured here.
