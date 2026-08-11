# Local Channel Runtime Reporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror only privacy-safe Bridge/Codex health and recovery checkpoints to Attention so Web can show the last trustworthy device state while local conversation remains functional without the model.

**Architecture:** A deterministic CLI Reporter uses an OAuth client and token dedicated to the `attention-channel-runtime` resource. It registers a local installation/binding, emits periodic and transition-triggered snapshots, and never runs through the model or business MCP. The server stores a strict snapshot next to the existing installation lifecycle and exposes account-scoped read views.

**Tech Stack:** TypeScript 6, OAuth 2.1 PKCE/DCR, Next.js route handlers, Drizzle/PostgreSQL 17, Zod contracts, Vitest, Playwright.

## Global Constraints

- Reporter OAuth is separate from Attention MCP OAuth and accepts exactly `runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report`.
- No iLink token, context token, sync cursor, Codex thread ID/token, chat text, raw link, reply, WeChat contact, phone number, or public WeChat ID may leave the device.
- Reporter failure never blocks local iLink polling, Agent turns, collection, or outbound replies.
- Heartbeat cadence is 60 seconds plus immediate transition reports; Web becomes stale after three missed windows.
- Server views are last-observed facts, not claims of current availability.
- Background services never open a browser; Runtime OAuth is completed during interactive configuration.
- Missing Runtime OAuth means “local may work; cloud status not connected,” not “WeChat disconnected.”

## File Structure

- Modify `packages/contracts/src/channel-runtime.ts`: strict runtime snapshot request/view schema.
- Modify `packages/contracts/src/channel-runtime.test.ts`: privacy and enum contract tests.
- Modify `packages/db/src/schema.ts`: nullable JSONB runtime snapshot column.
- Create `packages/db/drizzle/0026_channel_runtime_snapshot.sql`: additive migration.
- Modify migration journal/snapshot using the existing Drizzle workflow.
- Modify `apps/web/src/server/channel-runtime-service.ts`: persist/replay snapshots.
- Modify `apps/web/src/server/channel-runtime-http.ts`: validate heartbeat payload and expose views.
- Modify existing runtime HTTP/service/integration tests.
- Create `apps/cli/src/runtime-oauth.ts`: DCR, PKCE, loopback callback, refresh, and restricted token store.
- Create `apps/cli/src/runtime-oauth.test.ts`: OAuth and secret-handling tests.
- Create `apps/cli/src/channel/runtime-reporter.ts`: registration, binding, heartbeat, retry, and transition reporting.
- Create `apps/cli/src/channel/runtime-reporter.test.ts`: deterministic reporter tests.
- Modify `apps/cli/src/configure.ts`, `configure.test.ts`, `main.ts`, and `main.test.ts`: interactive Runtime OAuth flow.
- Modify `apps/cli/src/channel/channel-command.ts` and tests: Reporter lifecycle integration.
- Modify `apps/web/src/app/account/connections/page.tsx`: load account-scoped installation views.
- Modify `apps/web/src/components/connection-manager.tsx`: read-only last-status UI.
- Modify `apps/web/src/components/connection-manager.test.ts`: server-rendered status copy/structure tests.
- Modify `apps/web/src/app/globals.css`: responsive status card/table styles.
- Modify `tests/e2e/agent-connection-layout.spec.ts`: desktop/mobile layout coverage.
- Modify installation docs/manifests and generated CLI artifacts.

---

### Task 1: Versioned Privacy-Safe Runtime Snapshot Contract

**Files:**
- Modify: `packages/contracts/src/channel-runtime.ts`
- Modify: `packages/contracts/src/channel-runtime.test.ts`

**Interfaces:**
- Produces: `RuntimePhaseSchema`, `RuntimeCheckpointReportSchema`, and `runtime_checkpoint` on heartbeat/view.

- [ ] **Step 1: Write failing strict-schema tests**

```ts
const checkpoint = {
  bridge_status: "online",
  ilink_status: "connected",
  codex_phase: "restarting",
  last_healthy_at: "2026-08-10T10:00:00.000Z",
  last_successful_message_at: "2026-08-10T09:59:00.000Z",
  last_error_code: "codex_runtime_crashed",
  pending_inbound: 2,
  pending_outbound: 0,
};
expect(RuntimeCheckpointReportSchema.parse(checkpoint)).toEqual(checkpoint);
for (const forbidden of ["token", "thread_id", "message", "url", "reply"]) {
  expect(() => RuntimeCheckpointReportSchema.parse({ ...checkpoint, [forbidden]: "secret" })).toThrow();
}
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/contracts/src/channel-runtime.test.ts`

- [ ] **Step 3: Add exact enums and bounds**

Define bridge `online|degraded|stopping`, iLink `connected|reconnecting|signed_out`, Codex phases from the approved design, nullable ISO timestamps/error code, and integer queue counts from 0 through 10,000. Add `runtime_checkpoint` to `InstallationHeartbeatSchema` and nullable `runtime_checkpoint` to `InstallationViewSchema`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm vitest run packages/contracts/src/channel-runtime.test.ts
git add packages/contracts/src/channel-runtime.ts packages/contracts/src/channel-runtime.test.ts
git commit -m "feat: define local runtime checkpoint contract"
```

### Task 2: Persist and Return Last Runtime Checkpoint

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0026_channel_runtime_snapshot.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: generated Drizzle snapshot
- Modify: `apps/web/src/server/channel-runtime-service.ts`
- Modify: `apps/web/src/server/channel-runtime-http.ts`
- Test: existing runtime service, HTTP, schema, and integration tests.

**Interfaces:**
- Consumes: `RuntimeCheckpointReport` from Task 1.
- Produces: account-scoped `InstallationView.runtime_checkpoint`.

- [ ] **Step 1: Write failing persistence tests**

Heartbeat an installation with a checkpoint, replay the same `event_id`, and verify the first snapshot remains idempotent. Then send a newer event and verify only the latest snapshot is returned. Assert another account cannot read it.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run apps/web/src/server/channel-runtime-service.test.ts apps/web/src/server/channel-runtime-http.test.ts packages/db/src/channel-runtime-schema.test.ts`

- [ ] **Step 3: Add the additive migration**

```sql
ALTER TABLE "agent_installations"
ADD COLUMN "runtime_checkpoint" jsonb;
```

Add a DB check requiring an object when non-null and rejecting known forbidden keys (`token`, `thread_id`, `message`, `url`, `reply`). Keep shape validation in Zod at the HTTP boundary.

- [ ] **Step 4: Persist only after the runtime event is accepted**

Update `recordInstallationHeartbeat()` in the same account-scoped transaction that writes `lastSeenAt` and status. Store only the parsed strict checkpoint; duplicate event IDs return the existing view without rewriting.

- [ ] **Step 5: Verify migration and service**

Run:

```bash
pnpm --filter @attention/db typecheck
pnpm vitest run packages/db/src/channel-runtime-schema.test.ts apps/web/src/server/channel-runtime-service.test.ts apps/web/src/server/channel-runtime-http.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/contracts apps/web/src/server/channel-runtime-service.ts apps/web/src/server/channel-runtime-http.ts apps/web/src/server/channel-runtime-service.test.ts apps/web/src/server/channel-runtime-service.integration.test.ts apps/web/src/server/channel-runtime-http.test.ts
git commit -m "feat: store last local runtime checkpoint"
```

### Task 3: Dedicated Runtime OAuth Client and Credential Store

**Files:**
- Create: `apps/cli/src/runtime-oauth.ts`
- Create: `apps/cli/src/runtime-oauth.test.ts`
- Modify: `apps/cli/src/configure.ts`
- Modify: `apps/cli/src/configure.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/main.test.ts`

**Interfaces:**
- Produces: `authorizeRuntime()`, `loadRuntimeCredential()`, `runtimeAccessToken()`, and `clearRuntimeCredential()`.

- [ ] **Step 1: Write failing OAuth tests**

Use mocked metadata/DCR/token endpoints and an injected loopback callback. Verify exact resource and scopes, S256 PKCE, state validation, refresh rotation, atomic `0600` storage, redaction, and rejection of a business-MCP audience token.

```ts
expect(registration.resource).toBe("https://attention.example/api/runtime");
expect(new Set(authorizeUrl.searchParams.get("scope")?.split(" "))).toEqual(
  new Set(["runtime:register", "runtime:heartbeat", "channel:bind:report", "channel:disconnect:report"]),
);
expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run apps/cli/src/runtime-oauth.test.ts apps/cli/src/configure.test.ts apps/cli/src/main.test.ts`

- [ ] **Step 3: Implement OAuth discovery, DCR, PKCE, and refresh**

Discover the runtime protected-resource metadata, then authorization-server metadata. Register a public native client with a random loopback redirect, open the browser only in an interactive command, validate state, exchange the code with `code_verifier`, and persist client ID/refresh token/expiry in `~/.attention/runtime/credentials.json` using directory `0700`, file `0600`, and atomic rename.

- [ ] **Step 4: Integrate interactive configuration**

`attention configure codex --apply --login` completes the existing MCP host login and then the Runtime OAuth ceremony. `channel start --background` refuses to launch a fresh service until interactive Runtime OAuth has either succeeded or the user explicitly chooses local-only mode; the already-running service never launches a browser.

- [ ] **Step 5: Verify and commit**

```bash
pnpm vitest run apps/cli/src/runtime-oauth.test.ts apps/cli/src/configure.test.ts apps/cli/src/main.test.ts
git add apps/cli/src/runtime-oauth.ts apps/cli/src/runtime-oauth.test.ts apps/cli/src/configure.ts apps/cli/src/configure.test.ts apps/cli/src/main.ts apps/cli/src/main.test.ts
git commit -m "feat: authorize local channel runtime reporting"
```

### Task 4: Deterministic Installation, Binding, and Heartbeat Reporter

**Files:**
- Create: `apps/cli/src/channel/runtime-reporter.ts`
- Create: `apps/cli/src/channel/runtime-reporter.test.ts`
- Modify: `apps/cli/src/channel/state.ts`
- Modify: `apps/cli/src/channel/state.test.ts`
- Modify: `apps/cli/src/channel/channel-command.ts`
- Modify: `apps/cli/src/channel/channel-command.test.ts`

**Interfaces:**
- Consumes: Runtime access token and resident `RuntimeCheckpoint`.
- Produces: `RuntimeReporter.start()`, `transition()`, `activity()`, and `stop()`.

- [ ] **Step 1: Write failing reporter tests**

Test stable installation UUID, local random HMAC key, irreversible owner fingerprint, installation registration, binding report, 60-second heartbeats, immediate phase-change heartbeat, refresh-and-retry after 401, idempotent event UUID reuse, exponential network retry, and no blocking of the Bridge loop.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run apps/cli/src/channel/runtime-reporter.test.ts apps/cli/src/channel/channel-command.test.ts`

- [ ] **Step 3: Extend local state with reporter identifiers**

Persist `installationId`, `bindingId`, and a random 32-byte fingerprint key in local restricted state. Derive `channel_account_fingerprint = HMAC-SHA256(localKey, accountId)` and `paired_peer_fingerprint = HMAC-SHA256(localKey, ownerUserId)`; never send source identifiers.

- [ ] **Step 4: Implement non-blocking reporting**

Registration/binding must complete before claiming Web visibility, but transient failures only set `reporterStatus=degraded`. Heartbeats run from a separate timer/serialized promise chain. Critical phase transitions enqueue an immediate report without awaiting it in message processing. Shutdown attempts one bounded final report.

- [ ] **Step 5: Implement pairing verification**

The server-issued short pairing code is shown locally and must arrive through the bound iLink owner. The Bridge consumes the exact code as a deterministic control message, hashes the peer locally, calls verify, and replies with success; the code is never stored after completion.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run apps/cli/src/channel/runtime-reporter.test.ts apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/state.test.ts
git add apps/cli/src/channel/runtime-reporter.ts apps/cli/src/channel/runtime-reporter.test.ts apps/cli/src/channel/state.ts apps/cli/src/channel/state.test.ts apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts
git commit -m "feat: report local channel health without content"
```

### Task 5: Account-Scoped Web Last-Status View

**Files:**
- Modify: `apps/web/src/app/account/connections/page.tsx`
- Modify: `apps/web/src/components/connection-manager.tsx`
- Modify: `apps/web/src/components/connection-manager.test.ts`
- Modify: `apps/web/src/app/globals.css`
- Modify: `tests/e2e/agent-connection-layout.spec.ts`

**Interfaces:**
- Consumes: `InstallationView.runtime_checkpoint`.
- Produces: read-only device status, last online, checkpoint, and actionable local command copy.

- [ ] **Step 1: Write failing view tests**

Cover healthy, Codex degraded while Bridge online, stale after missed heartbeats, disconnected, local-only/no Reporter, and revoked states. Assert the page never says “微信已连接” for merely reported/unverified bindings.

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
pnpm vitest run apps/web/src/components/connection-manager.test.ts
pnpm playwright test tests/e2e/agent-connection-layout.spec.ts
```

- [ ] **Step 3: Render only trustworthy status**

Show device, Agent, verification level, Bridge/Codex phase, last online, queue counts, stable error explanation, and a copyable local diagnostic command. Copy must distinguish `本地可用，云端状态未连接` from true offline/stale.

- [ ] **Step 4: Verify responsive layout**

Run at desktop 1440px and mobile 390px. Confirm no horizontal document overflow, no Hosted Channel promise, no credential content, and no overlap with the mobile collection FAB.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/account/connections/page.tsx apps/web/src/components/connection-manager.tsx apps/web/src/components/connection-manager.test.ts apps/web/src/app/globals.css tests/e2e/agent-connection-layout.spec.ts
git commit -m "feat: show last local channel checkpoint"
```

### Task 6: Reporter Release Gate and Offline E2E

**Files:**
- Modify: public installation/runtime documentation and manifests.
- Modify: generated CLI artifact and manifest.
- Modify: `docs/local-agent-wechat-device-acceptance.md` with redacted evidence.

**Interfaces:**
- Consumes: completed Tasks 1–5 and the resident-runtime plan.
- Produces: deployable Reporter and verified privacy/availability behavior.

**Manifest promotion rule:** follow the source/output and generated-artifact
checklist in Task 5 of
[`2026-08-10-codex-resident-runtime.md`](./2026-08-10-codex-resident-runtime.md).
The Reporter implementation alone does not change a public claim. For Codex,
set Runtime reporting to `available` and `can_confirm_runtime` to `true` only
after the Runtime OAuth/heartbeat/privacy/offline gate below passes. Set
`can_confirm_channel_pairing` to `true` only after the real pairing challenge
passes. Keep Claude Code and every native host unchanged unless each has its
own release evidence. `INSTALL.md` is hand-authored and must be promoted
separately; the installation sync command will not edit it.

- [ ] **Step 1: Run contract, DB, CLI, Web, and artifact gates**

```bash
pnpm vitest run \
  packages/contracts/src/agent-integration.test.ts \
  packages/contracts/src/agent-installation.test.ts
pnpm agent-installations:sync
pnpm cli-artifact:sync
pnpm typecheck
pnpm test
pnpm lint
pnpm agent-installations:check
pnpm cli-artifact:check
pnpm capabilities:check
git diff --check
```

- [ ] **Step 2: Inspect the server record for privacy**

After a real pairing and heartbeat, query only the test account's installation/binding/event rows. Verify there are no token, thread ID, chat, URL, reply, contact, phone, or raw provider identifier values.

- [ ] **Step 3: Verify Codex-only failure**

Kill app-server while Bridge stays online. Confirm WeChat `状态` works immediately, Web shows Bridge online/Codex restarting, queued messages recover, and later heartbeat returns active.

- [ ] **Step 4: Verify whole-device stale boundary**

Stop the Bridge. Confirm no WeChat cloud reply is produced and Web becomes stale after three heartbeat windows with the final checkpoint retained.

- [ ] **Step 5: Verify Reporter outage independence**

Block only `/api/runtime`; send and collect a real link through iLink/Codex/MCP. Confirm collection succeeds, Reporter retries later, and Web never falsely changes the binding to disconnected.

- [ ] **Step 6: Commit redacted evidence**

```bash
git add docs apps/web/public/skills/attention apps/web/public/cli
git commit -m "test: verify local runtime reporting boundaries"
```
