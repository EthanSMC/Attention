# Codex Resident Channel Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-`codex exec`-per-message with one resident `codex app-server`, preserve strict Attention-only permissions, and keep the local Bridge responsive and recoverable when Codex fails.

**Architecture:** The existing local Bridge remains the sole iLink Channel Owner. A focused stdio JSON-RPC client owns one `codex app-server` child, while the Codex Brain Adapter translates `invoke()` into thread start/resume and turn start/completion. Durable state, deterministic control commands, and the existing serialized queues survive child-process failure.

**Tech Stack:** TypeScript 6, Node.js child processes/streams, Codex app-server JSON-RPC v2, Vitest 4, pnpm, esbuild.

## Global Constraints

- Bridge and all iLink credentials remain on the user's device.
- Product default is `gpt-5.6-luna`, reasoning effort `medium`, verbosity `low` for every Codex Channel user.
- Codex receives only the current Attention MCP Channel tool allowlist; Shell, filesystem writes, browser, other MCP servers, and unknown approvals are denied.
- The user has approved account-scoped Attention collection writes for this
  resident Channel. The allowlist therefore includes collection creation,
  candidate selection, and collection update in addition to the required read
  tools. Server-side account entitlements and visibility rules still apply;
  this approval does not authorize local filesystem writes or any non-Attention
  tool.
- One Bridge processes one Codex turn at a time; inbound and outbound queues remain durable.
- Resume the persisted thread ID first; if resume fails, replay the local last 20 user/assistant exchanges into a new thread.
- The resident protocol is mandatory for supported Codex versions; do not silently fall back to per-message `codex exec`.
- Normal chat has no generic acknowledgement; a recognized collection link may receive `正在收藏…`.
- Use full message IDs to derive a SHA-256 idempotency reference; never truncate a shared prefix.
- Preserve all existing uncommitted OAuth compatibility, model-default, reply, test, and generated-artifact changes.

## Verified Codex Protocol Corrections

Real `codex app-server` verification on 2026-08-10 supersedes any earlier
command-line assumptions in this plan:

- Earlier ignore-user-configuration/rules flags and app-server-level sandbox
  flags are invalid for this runtime and must not be used.
- Setting an empty MCP object on the command line merges with user
  configuration; it does not clear existing MCP servers and is not an
  isolation mechanism.
- Start app-server with a dedicated Channel `CODEX_HOME` that references the
  user's existing local Codex login without reading or copying its token. That
  home contains only the Attention MCP configuration.
- The supported launch shape is `codex --disable apps --disable plugins
  --disable skill_search -c 'mcp_servers.attention.url="<mcp-url>"' app-server
  --stdio`. Keep it as structured argv and launch with `shell: false`.
- Put `sandbox: "read-only"` in thread start/resume parameters and a read-only,
  no-network `sandboxPolicy` in turn parameters. Do not pass it on app-server
  argv.
- After initialize, call `mcpServerStatus/list` and fail closed unless the
  returned server list is exactly one server named `attention`.
- Text input for `turn/start` is `{ type: "text", text, text_elements: [] }`.

The transport and real protocol behavior have been verified. Remaining task
checkboxes still govern integration, artifacts, Reporter/Web work, and release
acceptance; this plan does not claim those unfinished pieces are deployed.

## File Structure

- Create `apps/cli/src/channel/codex-app-server-rpc.ts`: bounded newline-delimited JSON-RPC transport and child lifecycle.
- Create `apps/cli/src/channel/codex-app-server-rpc.test.ts`: protocol, timeout, crash, and rejection tests.
- Create `apps/cli/src/channel/brains/codex-resident.ts`: thread/turn state machine and Codex Brain Adapter.
- Create `apps/cli/src/channel/brains/codex-resident.test.ts`: resident lifecycle and recovery tests.
- Modify `apps/cli/src/channel/brain.ts`: optional lifecycle/status contract shared by Bridge adapters.
- Modify `apps/cli/src/channel/brains/codex.ts`: retain argument policy helpers; delegate runtime work to the resident adapter.
- Modify `apps/cli/src/channel/state.ts`: durable runtime phase and failure checkpoint.
- Modify `apps/cli/src/channel/state.test.ts`: migration, permissions, and bounded-history tests.
- Modify `apps/cli/src/channel/pipeline.ts`: deterministic control commands and hashed message refs.
- Modify `apps/cli/src/channel/pipeline.test.ts`: exact matching, offline commands, and hash tests.
- Modify `apps/cli/src/channel/channel-command.ts`: start/stop resident brain and persist phase transitions.
- Modify `apps/cli/src/channel/channel-command.test.ts`: signal, queue, and restart integration tests.
- Modify `apps/cli/src/channel/doctor.ts` and `doctor.test.ts`: app-server compatibility and local phase checks.
- Modify `apps/cli/src/channel/limits.ts`: restart/backoff constants.
- Modify `apps/cli/package.json`: bump the public CLI version before publishing
  changed runtime behavior.
- Modify `apps/web/public/cli/attention-<version>.mjs` and `manifest.json`:
  generated release artifacts only; never hand-edit either file.
- Modify channel runtime docs and public installation artifacts only where observable behavior changed.

---

### Task 1: Bounded Codex app-server JSON-RPC Transport

**Files:**
- Create: `apps/cli/src/channel/codex-app-server-rpc.ts`
- Create: `apps/cli/src/channel/codex-app-server-rpc.test.ts`

**Interfaces:**
- Produces: `CodexAppServerRpc.start()`, `request<T>()`, `onNotification()`, `snapshot()`, and `close()`.
- Produces: `CodexRpcNotification`, `CodexRpcSnapshot`, and injectable `spawnImpl`/clock seams.

- [ ] **Step 1: Write failing transport tests**

Test a fake child built from `PassThrough` streams. Cover `initialize` request/response correlation, interleaved notifications, malformed lines, stdout byte limit, request timeout, child exit rejection, and server-initiated approval rejection.

```ts
it("correlates responses while forwarding notifications", async () => {
  const child = fakeChild();
  const rpc = new CodexAppServerRpc({ spawnImpl: () => child.process });
  const seen: string[] = [];
  rpc.onNotification((event) => seen.push(event.method));
  const pending = rpc.request<{ ok: true }>("initialize", {
    clientInfo: { name: "attention-channel", title: "Attention", version: "0.2.0" },
    capabilities: null,
  });
  child.stdout.write('{"method":"thread/started","params":{"thread":{"id":"t-1"}}}\n');
  child.stdout.write('{"id":1,"result":{"ok":true}}\n');
  await expect(pending).resolves.toEqual({ ok: true });
  expect(seen).toEqual(["thread/started"]);
});

it("denies every server request by default", async () => {
  const { rpc, child } = startedRpc();
  child.stdout.write('{"id":91,"method":"item/commandExecution/requestApproval","params":{}}\n');
  await nextTick();
  expect(child.stdinText()).toContain('"id":91');
  expect(child.stdinText()).toContain('"decision":"decline"');
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `pnpm vitest run apps/cli/src/channel/codex-app-server-rpc.test.ts`

Expected: FAIL because `codex-app-server-rpc.ts` does not exist.

- [ ] **Step 3: Implement the minimal transport**

Use `spawn("codex", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] })`. Parse one JSON object per stdout line, allocate monotonically increasing integer request IDs, cap stdout/stderr buffers at 262,144 bytes, and reject pending requests on close. Respond to command/file approvals with `{ decision: "decline" }`; respond to permissions, dynamic tools, user input, token refresh, attestation, time, and every unknown server request with JSON-RPC method-not-supported. Authentication is made available through the dedicated Channel `CODEX_HOME`, which references the user's existing local login without parsing or copying the credential; the Bridge never reads or supplies Codex tokens.

```ts
export class CodexAppServerRpc {
  start(): Promise<void>;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  onNotification(listener: (event: CodexRpcNotification) => void): () => void;
  snapshot(): CodexRpcSnapshot;
  close(): Promise<void>;
}
```

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run apps/cli/src/channel/codex-app-server-rpc.test.ts`

Expected: all transport tests PASS and no open-handle warning.

- [ ] **Step 5: Commit the transport**

```bash
git add apps/cli/src/channel/codex-app-server-rpc.ts apps/cli/src/channel/codex-app-server-rpc.test.ts
git commit -m "feat: add Codex app-server transport"
```

### Task 2: Resident Codex Brain Adapter

**Files:**
- Create: `apps/cli/src/channel/brains/codex-resident.ts`
- Create: `apps/cli/src/channel/brains/codex-resident.test.ts`
- Modify: `apps/cli/src/channel/brain.ts`
- Modify: `apps/cli/src/channel/brains/codex.ts`
- Modify: `apps/cli/src/channel/brains/brains.test.ts`

**Interfaces:**
- Consumes: `CodexAppServerRpc` from Task 1.
- Produces: `BrainAdapter.start()`, `shutdown()`, `runtimeSnapshot()`, and resident `invoke()`.

- [ ] **Step 1: Add failing resident lifecycle tests**

Test one initialize call per process, `thread/resume` before new thread creation, `thread/start` after explicit resume failure, sequential `turn/start`, final Agent message extraction from `item/completed`, `turn/interrupt` on timeout, and child restart with bounded exponential backoff.

```ts
it("reuses one app-server and one thread for consecutive turns", async () => {
  const rpc = scriptedRpc();
  const brain = createCodexResidentBrain({ mcpUrl: "https://attention.example/mcp", rpc });
  const first = await brain.invoke({ cwd: "/tmp/channel", prompt: "one", sessionId: null });
  const second = await brain.invoke({ cwd: "/tmp/channel", prompt: "two", sessionId: first.sessionId });
  expect(rpc.startCount).toBe(1);
  expect(rpc.methods()).toEqual(["initialize", "thread/start", "turn/start", "turn/start"]);
  expect(second.sessionId).toBe(first.sessionId);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/brains.test.ts`

Expected: FAIL because resident adapter/lifecycle members are absent.

- [ ] **Step 3: Extend the Brain contract**

```ts
export interface BrainRuntimeSnapshot {
  readonly phase: "starting" | "healthy" | "restarting" | "recovering_thread" | "replaying_history" | "degraded_auth" | "degraded_runtime" | "stopped";
  readonly lastErrorCode: string | null;
  readonly retryAttempt: number;
}

export interface BrainAdapter {
  readonly hostId: "codex" | "claude-code";
  invoke(input: BrainInvokeInput): Promise<BrainOutcome>;
  shutdown(): Promise<void>;
  runtimeSnapshot(): BrainRuntimeSnapshot;
}
```

Give Claude Code a no-op shutdown and a subprocess snapshot so callers have no optional lifecycle branches.

- [ ] **Step 4: Implement thread and turn mapping**

Prepare a dedicated Channel `CODEX_HOME` that references the user's existing
Codex login and contains only the Attention MCP configuration. Start the
structured app-server argv described in **Verified Codex Protocol Corrections**,
send `initialize`, and fail closed unless `mcpServerStatus/list` returns exactly
the `attention` server. Send `thread/resume` or `thread/start` with read-only
sandbox parameters, then `turn/start` with one
`{ type: "text", text, text_elements: [] }` input and the read-only,
no-network sandbox policy. Resolve only after matching `turn/completed`; capture
the final `agentMessage` item for the matching thread and turn.

- [ ] **Step 5: Implement restart and recovery signaling**

On child exit, move to `restarting`, reject the active turn as retryable, and restart after 1s/2s/4s/8s/15s capped delays. Report `resumeFailed: true` only when `thread/resume` returns a protocol error that means the stored thread is unavailable; authentication failures become `degraded_auth`.

- [ ] **Step 6: Verify adapter behavior**

Run: `pnpm vitest run apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/brains.test.ts`

Expected: PASS; tests prove two messages create one child process.

- [ ] **Step 7: Commit the adapter**

```bash
git add apps/cli/src/channel/brain.ts apps/cli/src/channel/brains/codex.ts apps/cli/src/channel/brains/codex-resident.ts apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/brains.test.ts
git commit -m "feat: keep Codex channel runtime resident"
```

### Task 3: Durable Runtime Checkpoint and Deterministic Commands

**Files:**
- Modify: `apps/cli/src/channel/state.ts`
- Modify: `apps/cli/src/channel/state.test.ts`
- Modify: `apps/cli/src/channel/pipeline.ts`
- Modify: `apps/cli/src/channel/pipeline.test.ts`
- Modify: `apps/cli/src/channel/limits.ts`

**Interfaces:**
- Consumes: `BrainRuntimeSnapshot` from Task 2.
- Produces: `RuntimeCheckpoint`, `buildMessageRef()`, and `matchControlCommand()`.

- [ ] **Step 1: Write failing state and command tests**

Cover old state migration, atomic persistence of phases, retention of exactly 20 user/assistant exchanges, stable distinct SHA-256 message refs for IDs sharing a 64-character prefix, and exact control matching. Verify `继续讨论这个方案` is normal chat while exact `状态` is local.

```ts
expect(buildMessageRef(`${"a".repeat(100)}1`)).not.toBe(
  buildMessageRef(`${"a".repeat(100)}2`),
);
expect(matchControlCommand(" 状态 ", { degraded: true })).toBe("status");
expect(matchControlCommand("继续讨论", { degraded: true })).toBeNull();
expect(matchControlCommand("继续", { degraded: false })).toBeNull();
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run apps/cli/src/channel/state.test.ts apps/cli/src/channel/pipeline.test.ts`

Expected: FAIL on missing checkpoint and message-ref helpers.

- [ ] **Step 3: Add the checkpoint schema and safe defaults**

```ts
export interface RuntimeCheckpoint {
  phase: BrainRuntimeSnapshot["phase"];
  lastTransitionAt: string;
  lastHealthyAt: string | null;
  lastSuccessfulMessageAt: string | null;
  lastErrorCode: string | null;
  retryAttempt: number;
  nextRetryAt: string | null;
  activeTurnMessageRef: string | null;
}
```

Normalize missing/invalid fields to `stopped` with nullable timestamps; do not weaken the existing `0700` directory, `0600` file, or atomic rename behavior.

- [ ] **Step 4: Add exact local commands and hashed references**

Use `createHash("sha256").update(messageId).digest("hex").slice(0, 48)` and prefix `msg-`. Intercept exact Chinese or slash commands before model invocation. `status`, `help`, and `retry` work while degraded; `continue` is local only when an interrupted message can resume; `reset` retains the existing explicit behavior.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run apps/cli/src/channel/state.test.ts apps/cli/src/channel/pipeline.test.ts`

```bash
git add apps/cli/src/channel/state.ts apps/cli/src/channel/state.test.ts apps/cli/src/channel/pipeline.ts apps/cli/src/channel/pipeline.test.ts apps/cli/src/channel/limits.ts
git commit -m "feat: persist channel runtime checkpoints"
```

### Task 4: Bridge Lifecycle, Queue Recovery, and Shutdown

**Files:**
- Modify: `apps/cli/src/channel/channel-command.ts`
- Modify: `apps/cli/src/channel/channel-command.test.ts`
- Modify: `apps/cli/src/channel/messages.ts`
- Modify: `apps/cli/src/channel/messages.test.ts`

**Interfaces:**
- Consumes: lifecycle Brain Adapter and `RuntimeCheckpoint`.
- Produces: resident start/shutdown orchestration and deterministic local replies.

- [ ] **Step 1: Write failing Bridge integration tests**

Test that account verification and later turns share one Brain, SIGTERM awaits `brain.shutdown()` after state persistence, Codex failure leaves inbound queued, a status command completes while Codex is down, recovery resumes the queue in order, and outbound completion remains durable.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/messages.test.ts`

Expected: FAIL on lifecycle ordering and deterministic status behavior.

- [ ] **Step 3: Integrate resident startup and shutdown**

Create the Brain once after acquiring the Channel lock. Use it for account verification and the entire poll loop. On signal: stop scheduling new turns, persist state, interrupt/shutdown Brain, release the lock, then exit. Keep iLink polling alive while Brain phase is degraded.

- [ ] **Step 4: Preserve queue semantics during failure**

Do not call `completeInbound` when a normal message cannot obtain a final reply. Persist the failure checkpoint and leave the message at queue head. Local status/help/retry commands may complete independently without reordering the earlier business message.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/messages.test.ts apps/cli/src/channel/pipeline.test.ts`

```bash
git add apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/messages.ts apps/cli/src/channel/messages.test.ts
git commit -m "feat: recover resident channel turns without message loss"
```

### Task 5: Doctor, Artifacts, Documentation, and Full Local Gate

**Files:**
- Modify: `apps/cli/src/doctor.ts`
- Modify: `apps/cli/src/doctor.test.ts`
- Modify: `packages/contracts/src/agent-integration.ts` only when a capability
  has actually crossed its release gate.
- Modify: `packages/contracts/src/agent-installation.ts` for the Codex
  app-server compatibility probe and any manifest projection change.
- Modify: `packages/contracts/src/agent-integration.test.ts`
- Modify: `packages/contracts/src/agent-installation.test.ts`
- Modify: `apps/cli/package.json` with the new public CLI version.
- Modify: `apps/web/public/skills/attention/INSTALL.md`
- Modify: `apps/web/src/server/agent-connection-projection.ts` and its tests
  only when the released Runtime reporting state changes the `/doc`/connection
  copy.
- Generate: `apps/web/public/skills/attention/installations/v1/index.json`
- Generate: every file under
  `apps/web/public/skills/attention/installations/v1/agents/`
- Generate:
  `apps/web/public/skills/attention/installations/v1/templates/restricted-profile.json`
- Generate: `apps/web/public/cli/attention-<version>.mjs`
- Generate: `apps/web/public/cli/manifest.json`
- Modify: `docs/local-agent-wechat-device-acceptance.md`

**Interfaces:**
- Consumes: resident runtime status and minimum protocol behavior.
- Produces: user-visible diagnostics and synchronized public artifacts.

- [ ] **Step 1: Write failing doctor tests**

Require checks for `codex app-server --help`, compatible initialize/thread/turn support, persisted phase, last healthy time, queue counts, and actionable auth/runtime errors. Ensure JSON output contains no token, full owner ID, thread ID, or message text.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run apps/cli/src/doctor.test.ts apps/cli/src/main.test.ts`

- [ ] **Step 3: Implement diagnostics and update acceptance docs**

Describe resident behavior, local status commands, the 20-exchange recovery rule, and the no-cloud-fallback boundary. Keep the public installation command source-free and do not expose runtime internals in Web setup copy.

- [ ] **Step 4: Promote release truth deliberately**

Use this source-to-output map; do not edit generated public JSON or the public
CLI bundle by hand:

| Release truth | Authoritative source | Generated output |
|---|---|---|
| Codex/Channel capability, Runtime reporter availability, claims | `packages/contracts/src/agent-integration.ts` | projected through `agent-installation.ts` into the public catalog/host JSON |
| Codex minimum version and `codex app-server --help` compatibility probe | `packages/contracts/src/agent-installation.ts` | `installations/v1/agents/codex.json` |
| Attention-only restricted profile | `restrictedAgentProfileTemplate` in `packages/contracts/src/agent-installation.ts` | `installations/v1/templates/restricted-profile.json` |
| User-facing current/candidate wording and offline/privacy boundary | `apps/web/public/skills/attention/INSTALL.md` | none; this file is hand-authored and is **not** changed by either sync command |
| `/doc` and connection-page setup/status copy | `apps/web/src/server/agent-connection-projection.ts` plus manifest-driven components | rendered Web UI; not changed by either sync command |
| Public CLI version and Node requirement | `apps/cli/package.json` | `/cli/manifest.json` plus versioned bundle filename |
| Resident Bridge implementation | `apps/cli/src/**` | versioned single-file bundle under `apps/web/public/cli/` |

Promote the two capabilities independently:

1. **Resident Codex release without Reporter:** add the app-server compatibility
   probe, update INSTALL from “candidate” to “published”, and publish a new CLI
   artifact. Keep `runtime_reporting.availability: "contract_only"` and both
   Runtime/pairing claims `false`.
2. **Reporter release:** only after Runtime OAuth, heartbeat, binding and the
   privacy/offline device gate pass, change Codex Runtime reporting to
   `available` and `can_confirm_runtime` to `true`. Change
   `can_confirm_channel_pairing` only after the pairing challenge itself has
   passed end to end. Do not promote Claude Code or native hosts from the Codex
   evidence.

Do not invent a Codex `minimum_version` until a lowest passing release has been
tested. Until then retain `policy: "verify_at_install"` and require the real
`codex app-server --help`/protocol probe.

- [ ] **Step 5: Bump the CLI version and synchronize generated artifacts**

Before synchronization, bump `apps/cli/package.json` from the previously
published version. A runtime behavior change must not overwrite a cacheable
artifact at the same URL. The old versioned artifact may remain available for
already pinned installers; `/cli/manifest.json` must point to the new one.

Run:

```bash
pnpm vitest run \
  packages/contracts/src/agent-integration.test.ts \
  packages/contracts/src/agent-installation.test.ts
pnpm agent-installations:sync
pnpm cli-artifact:sync
```

`agent-installations:sync` rewrites the catalog, all five host manifests and the
restricted profile from contracts; it does not update `INSTALL.md`.
`cli-artifact:sync` builds `apps/cli/dist/index.js`, writes the new versioned
`.mjs`, and recalculates `/cli/manifest.json` (`version`, `node`,
`artifact_path`, `sha256`).

Inspect the generated diff before running checks:

```bash
git diff --name-status -- \
  apps/web/public/skills/attention/INSTALL.md \
  apps/web/public/skills/attention/installations/v1 \
  apps/web/public/cli
git diff -- apps/web/public/skills/attention/installations/v1/agents/codex.json
git diff -- apps/web/public/cli/manifest.json
```

Expected resident-only promotion: INSTALL changes, Codex compatibility data
changes, a new versioned CLI bundle appears, and the CLI manifest points to its
new SHA. Runtime availability/claims remain unchanged unless Reporter passed its
separate gate. Changes to unrelated host manifests require an explicit contracts
explanation, even though the generator rewrites all of them.

- [ ] **Step 6: Run the full generated-artifact and release gate**

Run:

```bash
pnpm --filter @attention/cli typecheck
pnpm vitest run apps/cli/src/channel apps/cli/src/doctor.test.ts apps/cli/src/main.test.ts
pnpm vitest run \
  packages/contracts/src/agent-integration.test.ts \
  packages/contracts/src/agent-installation.test.ts \
  apps/web/src/server/agent-installation-manifest.test.ts \
  apps/web/src/server/attention-cli-artifact.test.ts
pnpm lint
pnpm agent-installations:check
pnpm cli-artifact:check
pnpm capabilities:check
git diff --check
```

Expected: all commands PASS and generated artifacts are clean.

- [ ] **Step 7: Smoke the exact public artifact**

Read the path and checksum from `apps/web/public/cli/manifest.json`, hash the
referenced file, then execute that file rather than `apps/cli/dist/index.js`:

```bash
attention_public_cli_path="$(node -e 'const m=require("./apps/web/public/cli/manifest.json"); process.stdout.write(`apps/web/public${m.artifact_path}`)')"
attention_public_cli_sha="$(node -e 'const m=require("./apps/web/public/cli/manifest.json"); process.stdout.write(m.sha256)')"
attention_public_cli_actual_sha="$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$attention_public_cli_path")"
test "$attention_public_cli_actual_sha" = "$attention_public_cli_sha"
node "$attention_public_cli_path" --help
node "$attention_public_cli_path" channel status --json
unset attention_public_cli_path attention_public_cli_sha attention_public_cli_actual_sha
```

The JSON output must contain no iLink/Codex/MCP token, Codex thread/session ID,
message ID or text, URL, reply, contact, or raw WeChat identifier. Real iLink
and app-server failure acceptance remains Task 6 and cannot be replaced by
these smoke commands.

After deployment, verify that the public origin serves the reviewed artifact
and manifest rather than merely passing the container-local health check:

```bash
./deploy/staging/smoke-test.sh --public
```

- [ ] **Step 8: Commit the reviewed release-facing set**

```bash
git add \
  apps/cli/package.json \
  apps/cli/src/doctor.ts \
  apps/cli/src/doctor.test.ts \
  packages/contracts/src/agent-integration.ts \
  packages/contracts/src/agent-integration.test.ts \
  packages/contracts/src/agent-installation.ts \
  packages/contracts/src/agent-installation.test.ts \
  apps/web/src/server/agent-connection-projection.ts \
  apps/web/src/server/agent-connection-projection.test.ts \
  apps/web/public/skills/attention \
  apps/web/public/cli \
  docs/local-agent-wechat-device-acceptance.md
git commit -m "docs: publish resident Codex channel runtime"
```

### Task 6: Real Codex and iLink Failure E2E

**Files:**
- Modify: `docs/local-agent-wechat-device-acceptance.md` with dated, redacted evidence only.

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: release evidence for the resident runtime.

- [ ] **Step 1: Install the candidate CLI artifact locally**

Verify its SHA-256 against `apps/web/public/cli/manifest.json`, replace the existing local artifact atomically, and restart `cn.noveltystudio.attention.channel`.

- [ ] **Step 2: Verify latency and thread reuse**

Send `你叫啥` followed by `你能做什么`. Confirm one app-server PID, one thread ID, matching replies, no generic acknowledgement, and segmented timing for queue/app-server/model/iLink.

- [ ] **Step 3: Verify child crash recovery**

Kill only the app-server child while Bridge remains running. Send `状态`, confirm immediate deterministic reply, then send a normal message. Confirm automatic restart, thread resume, and ordered final delivery.

- [ ] **Step 4: Verify stale-thread replay**

Replace the local thread ID with an invalid UUID while preserving history. Restart the service, send a follow-up that depends on earlier context, and verify creation of a new thread after replaying 20 exchanges.

- [ ] **Step 5: Verify whole-Bridge boundary**

Stop the Bridge and confirm WeChat receives no fabricated cloud reply. Restart it and confirm durable queue/cursor recovery.

- [ ] **Step 6: Record redacted evidence and commit**

Record timestamps, phase transitions, process IDs only as ephemeral evidence, response matching, and queue counts. Never record iLink/Codex/MCP credentials or full user identifiers.

```bash
git add docs/local-agent-wechat-device-acceptance.md
git commit -m "test: verify resident Codex channel recovery"
```
