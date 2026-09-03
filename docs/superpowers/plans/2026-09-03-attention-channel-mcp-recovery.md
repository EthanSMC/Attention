# Attention Channel MCP Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the WeChat/iLink Bridge responsive when Attention MCP OAuth or transport fails, prove MCP readiness with a real structured tool result, and let the user trigger a safe recovery from natural-language chat.

**Architecture:** The resident agent host remains responsible for Codex/Claude process and turn transport. A Bridge-owned MCP readiness layer consumes structured `attention_get_my_account` tool evidence, persists a separate MCP checkpoint, classifies failures, and drives single-flight recovery with bounded backoff. iLink, agent runtime, and Attention MCP are reported as independent health dimensions; OAuth reauthorization remains an explicit user action and never blocks ordinary chat.

**Tech Stack:** TypeScript, Node.js, Vitest, Codex app-server JSON-RPC, Claude stream-json, MCP OAuth, pnpm, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-03-attention-channel-mcp-recovery-design.md`

## Global Constraints

- Preserve unrelated working-tree changes. Never reset, clean, overwrite, or commit `.codex/` or changes belonging to the admin task.
- Use `attention_get_my_account` structured tool completion as the only positive readiness proof. Model prose, server-name presence, and process liveness are not readiness evidence.
- Keep Codex account authentication distinct from Attention MCP OAuth. A 401 from the MCP call must not be reported as “Codex login expired.”
- Never read, print, copy, or persist OAuth access/refresh tokens in Attention code or logs.
- Use Codex’s supported credential-store settings. Do not invent a token broker or make file-mode credentials the default.
- Treat `auth_required` as terminal until user action. Retry only transient transport/protocol failures.
- Preserve inbound queue durability and ordinary chat while MCP is degraded.
- Do not deploy, publish, push, or merge as part of this plan.

## File Structure

### New files

- `apps/cli/src/channel/mcp-readiness.ts` — MCP status/error types, structured account parser, failure classifier, and checkpoint transitions.
- `apps/cli/src/channel/mcp-readiness.test.ts` — unit coverage for account parsing, redacted failure classification, state transitions, and retry policy.
- `apps/cli/src/channel/mcp-recovery-supervisor.ts` — Bridge-owned single-flight recovery and automatic retry scheduler.
- `apps/cli/src/channel/mcp-recovery-supervisor.test.ts` — deterministic timer/lifecycle tests for manual and automatic recovery.

### Modified files

- `apps/cli/src/channel/state.ts` / `state.test.ts` — persist and normalize an independent Attention MCP checkpoint.
- `apps/cli/src/channel/brain.ts` — expose structured MCP probe evidence on `BrainOutcome` and MCP status on runtime snapshots.
- `apps/cli/src/channel/brains/codex-resident.ts` / `.test.ts` — capture Codex `mcpToolCall` completion/failure evidence for the account probe.
- `apps/cli/src/channel/brains/claude-resident.ts` / `.test.ts` — capture equivalent Claude `tool_use`/`tool_result` evidence.
- `apps/cli/src/channel/channel-command.ts` / `.test.ts` — replace marker-text verification, wire the supervisor, and keep chat/queues alive during MCP degradation.
- `apps/cli/src/channel/pipeline.ts` / `.test.ts` — recognize safe natural retry phrases and emit result-driven control replies.
- `apps/cli/src/channel/brains/codex.ts`, new `apps/cli/src/channel/brains/codex.test.ts`, `apps/cli/src/channel/codex-home.ts`, and `codex-home.test.ts` — make the supported credential-store mode explicit and stable across configure/runtime without exposing secrets.
- `apps/cli/src/configure.ts` / `configure.test.ts` — align the interactive MCP login and resident runtime configuration.
- `docs/local-agent-wechat-device-acceptance.md` — document independent health, retry, auth-required, and upstream iLink checks.
- `apps/cli/src/version.ts`, `apps/cli/package.json`, `apps/web/public/cli/manifest.json`, `apps/web/public/cli/attention-0.3.12.mjs` — release-compatible local artifact bump after verification.

---

## Task 1: Define MCP readiness data and persist it independently

**Files:**

- Create: `apps/cli/src/channel/mcp-readiness.ts`
- Create: `apps/cli/src/channel/mcp-readiness.test.ts`
- Modify: `apps/cli/src/channel/state.ts`
- Modify: `apps/cli/src/channel/state.test.ts`

- [ ] **Step 1: Write the failing readiness parser and classifier tests**

Add tests that accept only the current `attention_get_my_account` contract and never include email or token data:

```ts
import {
  classifyAttentionMcpFailure,
  parseAttentionAccountProbe,
} from "./mcp-readiness";

it("parses a structured account probe", () => {
  expect(
    parseAttentionAccountProbe({
      capabilities: { is_filter: true, is_member: true },
      profile: {
        attention_id: "ethan_01",
        display_name: "Ethan",
        has_avatar: true,
      },
    }),
  ).toEqual({
    attentionId: "ethan_01",
    displayName: "Ethan",
    isFilter: true,
    isMember: true,
  });
});

it("rejects model prose and malformed payloads", () => {
  expect(parseAttentionAccountProbe("ATTENTION_ACCOUNT_OK")).toBeNull();
  expect(parseAttentionAccountProbe({ profile: { display_name: "Ethan" } })).toBeNull();
});

it.each([
  ["OAuth authorization required", "mcp_auth_required", false],
  ["refresh token rejected", "mcp_token_refresh_failed", false],
  ["connect ECONNREFUSED", "mcp_server_unreachable", true],
  ["initialize request timed out", "mcp_protocol_failed", true],
])("classifies redacted MCP failures", (message, errorCode, retryable) => {
  expect(classifyAttentionMcpFailure({ message })).toMatchObject({
    errorCode,
    retryable,
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/mcp-readiness.test.ts
```

Expected: FAIL because `mcp-readiness.ts` does not exist.

- [ ] **Step 3: Implement the minimal domain types and pure helpers**

Use these public shapes:

```ts
export type AttentionMcpStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "reconnecting"
  | "auth_required"
  | "unreachable"
  | "tool_error";

export type AttentionMcpErrorCode =
  | "mcp_auth_required"
  | "mcp_token_refresh_failed"
  | "mcp_server_unreachable"
  | "mcp_protocol_failed"
  | "mcp_account_probe_failed";

export interface VerifiedAttentionAccount {
  attentionId: string | null;
  displayName: string;
  isFilter: boolean;
  isMember: boolean;
}

export interface AttentionMcpFailure {
  errorCode: AttentionMcpErrorCode;
  retryable: boolean;
}

export type AttentionMcpProbeResult =
  | { account: VerifiedAttentionAccount; ok: true }
  | ({ ok: false } & AttentionMcpFailure);

export interface AttentionMcpCheckpoint {
  lastErrorCode: AttentionMcpErrorCode | null;
  lastCheckedAt: string | null;
  lastReadyAt: string | null;
  nextRetryAt: string | null;
  retryAttempt: number;
  status: AttentionMcpStatus;
}
```

Parse with the shared `AttentionToolSuccessOutputSchemas.attention_get_my_account` schema from `@attention/contracts`, then map snake_case tool output to the camelCase runtime type. Classify only redacted strings/codes; discard raw error bodies after classification.

- [ ] **Step 4: Add state normalization tests**

Extend `state.test.ts` with:

```ts
it("adds an independent default Attention MCP checkpoint", async () => {
  const state = await store.load();
  expect(state.attentionMcp).toEqual({
    lastErrorCode: null,
    lastCheckedAt: null,
    lastReadyAt: null,
    nextRetryAt: null,
    retryAttempt: 0,
    status: "unknown",
  });
});

it("normalizes an invalid persisted MCP checkpoint without changing runtime state", async () => {
  // Persist an invalid status/retry count through the existing test helper.
  const state = await store.load();
  expect(state.attentionMcp.status).toBe("unknown");
  expect(state.attentionMcp.retryAttempt).toBe(0);
  expect(state.runtimeState.phase).toBeDefined();
});
```

- [ ] **Step 5: Extend `ChannelState` and normalization**

Add `attentionMcp: AttentionMcpCheckpoint`, a default factory, and strict normalization. Do not overload `runtimeState.phase`; legacy state files without this field must load with `unknown`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/mcp-readiness.test.ts apps/cli/src/channel/state.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the domain layer**

```bash
git add apps/cli/src/channel/mcp-readiness.ts apps/cli/src/channel/mcp-readiness.test.ts apps/cli/src/channel/state.ts apps/cli/src/channel/state.test.ts
git commit -m "feat(cli): model channel MCP readiness"
```

---

## Task 2: Capture structured account-probe evidence from resident hosts

**Files:**

- Modify: `apps/cli/src/channel/brain.ts`
- Modify: `apps/cli/src/channel/brains/codex-resident.ts`
- Modify: `apps/cli/src/channel/brains/codex-resident.test.ts`
- Modify: `apps/cli/src/channel/brains/claude-resident.ts`
- Modify: `apps/cli/src/channel/brains/claude-resident.test.ts`
- Modify: `apps/cli/src/channel/brains/brains.test.ts`

- [ ] **Step 1: Add failing Codex structured-evidence tests**

Use the existing fake app-server harness to send a completed MCP item:

```ts
it("returns structured readiness only after attention_get_my_account completes", async () => {
  rpc.completeMcpToolCall({
    server: "attention",
    tool: "attention_get_my_account",
    result: {
      structuredContent: {
        capabilities: { is_filter: false, is_member: true },
        profile: {
          attention_id: "ethan_01",
          display_name: "Ethan",
          has_avatar: false,
        },
      },
    },
  });
  await expect(outcome).resolves.toMatchObject({
    attentionMcpProbe: {
      ok: true,
      account: { attentionId: "ethan_01", isMember: true },
    },
  });
});

it("does not treat an MCP OAuth failure as Codex account auth failure", async () => {
  rpc.failMcpToolCall({
    message: "OAuth authorization required",
    server: "attention",
    tool: "attention_get_my_account",
  });
  await expect(outcome).resolves.toMatchObject({
    attentionMcpProbe: {
      errorCode: "mcp_auth_required",
      ok: false,
    },
  });
});
```

Also assert that merely receiving `mcpServerStatus/list` with `{ name: "attention" }` never creates a successful probe.

Add a non-probe test in which `attention_collect_content` fails with MCP OAuth/transport evidence and assert `outcome.attentionMcpFailure` is populated even though `outcome.attentionMcpProbe` is absent.

- [ ] **Step 2: Add failing Claude structured-evidence tests**

Drive the existing stream-json harness with `tool_use` named `mcp__attention__attention_get_my_account`, followed by matching `tool_result`. Assert success, `is_error` classification, and no success before the matching result arrives.

- [ ] **Step 3: Run resident tests and confirm failure**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/claude-resident.test.ts apps/cli/src/channel/brains/brains.test.ts
```

Expected: FAIL because `BrainOutcome` and active turns do not expose account-probe evidence.

- [ ] **Step 4: Extend the adapter contract**

Add optional evidence fields without breaking unrelated turns:

```ts
export interface BrainOutcome {
  attentionMcpFailure?: AttentionMcpFailure;
  attentionMcpProbe?: AttentionMcpProbeResult;
  collectionReplyControl?: CollectionReplyControl;
  ok: boolean;
  reply: string;
  resumeFailed: boolean;
  sessionId: string | null;
  timedOut: boolean;
}
```

Do not add account data to prompts or free-form logs.

- [ ] **Step 5: Implement Codex event capture**

Track the `attention_get_my_account` MCP item ID in `ActiveTurn`. On `item/completed`, extract `structuredContent` (or JSON text through the existing `mcpResultPayload`) and call `parseAttentionAccountProbe`. On failed completion, call `classifyAttentionMcpFailure`. Record failures from any Attention MCP tool in `attentionMcpFailure`; only the account tool may produce positive readiness evidence.

Split generic authentication classification into:

- Codex account auth: login/session errors emitted by app-server initialization or turn transport.
- Attention MCP auth: failures attached to the Attention MCP server/tool call.

Never downgrade an unknown MCP tool failure to “waiting”; emit `mcp_account_probe_failed` with `retryable: false`.

- [ ] **Step 6: Implement Claude event capture**

Reuse the existing `pendingToolNames` map. For the matching `tool_result`, parse successful content or classify `is_error` content. Keep Claude-specific transport handling intact.

- [ ] **Step 7: Run resident and type tests**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/claude-resident.test.ts apps/cli/src/channel/brains/brains.test.ts
pnpm --filter @attention/cli typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit structured evidence**

```bash
git add apps/cli/src/channel/brain.ts apps/cli/src/channel/brains/codex-resident.ts apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/claude-resident.ts apps/cli/src/channel/brains/claude-resident.test.ts apps/cli/src/channel/brains/brains.test.ts
git commit -m "feat(cli): observe structured MCP readiness"
```

---

## Task 3: Replace model-authored verification markers with a real probe

**Files:**

- Modify: `apps/cli/src/channel/channel-command.ts`
- Modify: `apps/cli/src/channel/channel-command.test.ts`

- [ ] **Step 1: Rewrite account-verification tests to reject marker prose**

Replace `ATTENTION_ACCOUNT_OK` expectations with structured outcomes:

```ts
it("accepts a verified structured tool result", async () => {
  const brain = fakeBrain({
    attentionMcpProbe: {
      account: {
        attentionId: "ethan_01",
        displayName: "Ethan",
        isFilter: true,
        isMember: true,
      },
      ok: true,
    },
    ok: true,
    reply: "任意模型文字",
  });
  await expect(verifyAttentionAccount(brain, cwd)).resolves.toMatchObject({
    ok: true,
  });
});

it("rejects a model-authored success marker without tool evidence", async () => {
  const brain = fakeBrain({ ok: true, reply: "ATTENTION_ACCOUNT_OK" });
  await expect(verifyAttentionAccount(brain, cwd)).resolves.toEqual({
    errorCode: "mcp_account_probe_failed",
    ok: false,
    retryable: false,
  });
});
```

Add coverage for `mcp_auth_required` and `mcp_server_unreachable` pass-through.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/channel-command.test.ts -t "account|probe|verification"
```

Expected: FAIL because verification still parses model text.

- [ ] **Step 3: Change verifier and dependency signatures**

Use:

```ts
export async function verifyAttentionAccount(
  brain: BrainAdapter,
  cwd: string,
): Promise<AttentionMcpProbeResult>;
```

Keep the disposable `sessionId: null` invocation, but instruct the host to call the tool and return a brief user-facing summary; only `outcome.attentionMcpProbe` determines verification. Update `ChannelCommandOptions.accountVerifier` and test fakes to this type.

- [ ] **Step 4: Persist the result without leaking identity**

On success, update `accountVerification` and `attentionMcp` timestamps/status. On failure, persist only status, stable error code, attempt, and retry timing. Do not persist display name or tool payload in `ChannelState`.

- [ ] **Step 5: Run command tests**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/channel-command.test.ts
pnpm --filter @attention/cli typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the real preflight**

```bash
git add apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts
git commit -m "fix(cli): require real MCP account probe"
```

---

## Task 4: Add the Bridge-owned single-flight recovery supervisor

**Files:**

- Create: `apps/cli/src/channel/mcp-recovery-supervisor.ts`
- Create: `apps/cli/src/channel/mcp-recovery-supervisor.test.ts`
- Modify: `apps/cli/src/channel/channel-command.ts`
- Modify: `apps/cli/src/channel/channel-command.test.ts`

- [ ] **Step 1: Write deterministic supervisor tests**

Use fake timers and injected dependencies:

```ts
it("coalesces concurrent manual retries", async () => {
  const first = supervisor.retryNow();
  const second = supervisor.retryNow();
  expect(restart).toHaveBeenCalledTimes(1);
  expect(first).toBe(second);
});

it("restarts then proves readiness before reporting ready", async () => {
  probe.mockResolvedValueOnce({
    account: verifiedAccount,
    ok: true,
  });
  await expect(supervisor.retryNow()).resolves.toEqual({
    account: verifiedAccount,
    kind: "ready",
  });
  expect(restart.mock.invocationCallOrder[0]).toBeLessThan(
    probe.mock.invocationCallOrder[0]!,
  );
});

it("backs off transient errors but stops on auth_required", async () => {
  probe.mockResolvedValueOnce({
    errorCode: "mcp_server_unreachable",
    ok: false,
    retryable: true,
  });
  await expect(supervisor.retryNow()).resolves.toMatchObject({ kind: "scheduled" });

  probe.mockResolvedValueOnce({
    errorCode: "mcp_auth_required",
    ok: false,
    retryable: false,
  });
  await expect(supervisor.retryNow()).resolves.toEqual({ kind: "auth_required" });
  expect(pendingTimerCount()).toBe(0);
});
```

Add tests that `stop()` cancels timers, retry success clears attempt/nextRetryAt, server-unreachable retries cap at 60 seconds, protocol failures stop as `tool_error` after five failed probes, and a failed recovery never drops inbound or outbound queue items.

- [ ] **Step 2: Run supervisor tests and confirm failure**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/mcp-recovery-supervisor.test.ts
```

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Implement the controller**

Use the following result union:

```ts
export type McpRecoveryOutcome =
  | { account: VerifiedAttentionAccount; kind: "ready" }
  | { kind: "auth_required" }
  | { kind: "cooldown"; retryAt: string }
  | { errorCode: AttentionMcpErrorCode; kind: "scheduled"; nextRetryAt: string }
  | { errorCode: AttentionMcpErrorCode; kind: "failed" };

export interface McpRecoveryDependencies {
  now(): Date;
  probe(): Promise<AttentionMcpProbeResult>;
  restart(): Promise<void>;
  saveCheckpoint(checkpoint: AttentionMcpCheckpoint): Promise<void>;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}
```

Recovery order is fixed:

1. Persist `reconnecting`.
2. Restart only the resident host, not iLink.
3. Invoke a fresh structured account probe.
4. Persist `ready`, `auth_required`, `unreachable`, or `tool_error`.
5. Schedule retryable network failures with `ATTENTION_MCP_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000]`; attempts beyond the array stay capped at 60 seconds. Stop protocol retries after five failures and persist `tool_error`.

Hold one in-flight promise. Enforce `ATTENTION_MCP_MANUAL_RETRY_COOLDOWN_MS = 3_000` and return `cooldown` with its expiry rather than starting another process. Do not send chat replies from the supervisor; return typed outcomes to `channel-command.ts`.

- [ ] **Step 4: Wire startup and shutdown**

Instantiate the supervisor after the iLink transport is usable. Startup probe failure must not throw out of Bridge startup. `auth_required` stays idle; transient errors schedule automatic recovery. On shutdown, cancel timers before shutting down the brain.

- [ ] **Step 5: Prove ordinary chat and queues stay live**

Add `channel-command.test.ts` integration cases:

- MCP preflight returns `auth_required`, then an ordinary “你好” reaches `brain.invoke` and its response is queued.
- A transient MCP outage schedules recovery while pending inbound rows stay pending until their normal processing path completes.
- A recovery restart does not disconnect iLink or clear outbound messages.
- An ordinary turn that contains `attentionMcpFailure` stays incomplete with its message reference and is executed exactly once after readiness returns; an ordinary turn without an MCP call still completes while MCP is degraded.

- [ ] **Step 6: Run focused recovery tests**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/mcp-recovery-supervisor.test.ts apps/cli/src/channel/channel-command.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the supervisor**

```bash
git add apps/cli/src/channel/mcp-recovery-supervisor.ts apps/cli/src/channel/mcp-recovery-supervisor.test.ts apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts
git commit -m "feat(cli): supervise channel MCP recovery"
```

---

## Task 5: Make chat retry commands safe, natural, and result-driven

**Files:**

- Modify: `apps/cli/src/channel/pipeline.ts`
- Modify: `apps/cli/src/channel/pipeline.test.ts`
- Modify: `apps/cli/src/channel/channel-command.ts`
- Modify: `apps/cli/src/channel/channel-command.test.ts`

- [ ] **Step 1: Add matcher tests for intended and unintended phrases**

```ts
it.each([
  "重试",
  "重试一下",
  "重新连接",
  "重新连接一下",
  "重连",
  "帮我重连一下？",
  "帮我重试一下",
  "再试一次。",
  "/retry",
])("recognizes a standalone recovery request: %s", (text) => {
  expect(matchControlCommand(text)).toBe("retry");
});

it.each([
  "帮我重试这段代码",
  "重新连接数据库",
  "为什么重试还是失败",
  "写一个 retry 函数",
])("does not hijack ordinary chat: %s", (text) => {
  expect(matchControlCommand(text)).toBeNull();
});
```

Add NFKC/full-width punctuation and surrounding-whitespace cases.

- [ ] **Step 2: Add result-reply tests**

Assert the user gets an immediate acknowledgment and then exactly one terminal result:

- ready: `Attention MCP 已恢复，并已验证当前账号。`
- auth required: `Attention MCP 需要重新授权；微信对话仍可用。请在本机运行 attention configure codex --apply --login，完成后回复“重试”。`
- transient: include next retry time and state that chat remains available.
- cooldown: report the earliest safe retry time without restarting the resident again.
- tool error: stable error code, no raw server body.

Status output must include iLink, agent runtime, Attention MCP, queues, and Reporter when Reporter is enabled.

- [ ] **Step 3: Run matcher/reply tests and confirm failure**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/pipeline.test.ts apps/cli/src/channel/channel-command.test.ts -t "retry|control|status|MCP"
```

Expected: FAIL because matching is exact and the reply is produced before recovery finishes.

- [ ] **Step 4: Implement anchored normalization**

Normalize with `NFKC`, trim whitespace, and remove only trailing sentence punctuation. Match an allowlist of complete utterances; do not use a broad substring regex.

```ts
const retryUtterances = new Set([
  "/retry",
  "重试",
  "重新连接",
  "帮我重连一下",
  "帮我重试一下",
  "再试一次",
]);
```

- [ ] **Step 5: Move reply ownership to the recovery caller**

`pipeline.ts` should identify and durably record the control command, but `channel-command.ts` owns the recovery acknowledgment and terminal reply because it has the typed outcome. Mark the inbound control message complete only after the terminal reply is persisted to the outbound queue. On process interruption, the pending control message is replayed idempotently; supervisor single-flight prevents duplicate restarts.

- [ ] **Step 6: Expand status without conflating components**

Example format:

```text
iLink：已登录
Agent Runtime：healthy
Attention MCP：auth_required（微信对话仍可用）
队列：1 条待处理，0 条待发送
```

Do not say the Attention account is offline when only MCP authorization is missing.

- [ ] **Step 7: Run full pipeline/command tests**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/pipeline.test.ts apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/mcp-recovery-supervisor.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit chat recovery UX**

```bash
git add apps/cli/src/channel/pipeline.ts apps/cli/src/channel/pipeline.test.ts apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts
git commit -m "feat(cli): recover MCP from WeChat chat"
```

---

## Task 6: Align OAuth credential storage without handling tokens in Attention

**Files:**

- Modify: `apps/cli/src/channel/brains/codex.ts`
- Create: `apps/cli/src/channel/brains/codex.test.ts`
- Modify: `apps/cli/src/channel/codex-home.ts`
- Modify: `apps/cli/src/channel/codex-home.test.ts`
- Modify: `apps/cli/src/configure.ts`
- Modify: `apps/cli/src/configure.test.ts`

**Compatibility basis:** Current Codex officially supports `mcp_oauth_credentials_store = auto | file | keyring`. On macOS/Linux, the default direct keyring credential key is derived from server name and URL rather than `CODEX_HOME`, so the global login and isolated resident can reuse it when both use the same Attention server identity and direct keyring backend. File fallback is scoped to `CODEX_HOME`, and the newer encrypted-secrets backend can also become home-scoped; both must be detected rather than silently treated as reusable.

- [ ] **Step 1: Add failing argument-consistency tests**

Assert that both interactive login and resident app-server use:

```text
mcp_oauth_credentials_store="keyring"
mcp_servers.attention.url="${normalizedAttentionMcpUrl}"
features.secret_auth_storage=false
```

Also assert the resident keeps its isolated `CODEX_HOME`, links only Codex account `auth.json`, and never links/copies `.credentials.json`, `secrets/`, or raw MCP credentials.

- [ ] **Step 2: Add a supported-Codex capability check**

Parse `codex --version` and fail configuration with a clear upgrade message if the installed Codex lacks `mcp_oauth_credentials_store` or `features.secret_auth_storage`. Unit-test the probe with injected command output; do not shell out from pure tests.

The failure message must state that the Bridge will continue chat but Attention MCP cannot be safely auto-recovered on this Codex build.

- [ ] **Step 3: Run configure/home/brain tests and confirm failure**

Run:

```bash
pnpm exec vitest run apps/cli/src/configure.test.ts apps/cli/src/channel/codex-home.test.ts apps/cli/src/channel/brains/codex.test.ts
```

Expected: FAIL because the credential policy is not explicit or consistently passed.

- [ ] **Step 4: Implement one shared credential-policy builder**

Export a helper used by both configure and resident startup:

```ts
export const ATTENTION_MCP_CREDENTIAL_OVERRIDES = [
  'mcp_oauth_credentials_store="keyring"',
  "features.secret_auth_storage=false",
] as const;
```

Build the Attention URL override from one normalized value. Pass identical server name `attention` and URL to `codex mcp login attention` and app-server. Redact command diagnostics through the existing redactor.

- [ ] **Step 5: Add an interactive compatibility acceptance gate**

After unit tests, run the supported login command only when user interaction is available:

```bash
attention configure codex --apply --login
```

Then start the Bridge and issue `状态`, followed by `重试` if necessary. Acceptance requires a structured `attention_get_my_account` result from the isolated resident without a second OAuth flow.

If the installed Codex rejects either override or the isolated resident cannot reuse the keyring entry, stop this task and report the exact Codex version and safe compatibility blocker. Do not switch to file mode, copy credentials, or prompt for a second silent login.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
pnpm exec vitest run apps/cli/src/configure.test.ts apps/cli/src/channel/codex-home.test.ts apps/cli/src/channel/brains/codex.test.ts
pnpm --filter @attention/cli typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit OAuth alignment**

```bash
git add apps/cli/src/configure.ts apps/cli/src/configure.test.ts apps/cli/src/channel/codex-home.ts apps/cli/src/channel/codex-home.test.ts apps/cli/src/channel/brains/codex.ts apps/cli/src/channel/brains/codex.test.ts
git commit -m "fix(cli): align channel MCP OAuth storage"
```

---

## Task 7: Document acceptance boundaries and verify the complete CLI

**Files:**

- Modify: `docs/local-agent-wechat-device-acceptance.md`
- Modify as required by test fixes only: `apps/cli/src/channel/*.test.ts`

- [ ] **Step 1: Add acceptance scenarios to the document**

Document these separate checks:

1. iLink login/token health.
2. Codex/Claude resident process health.
3. Attention MCP structured account probe health.
4. Natural chat recovery, including “帮我重连一下？”.
5. Auth-required behavior: ordinary chat works; collection tools explain authorization; no automatic OAuth browser loop.
6. Transient MCP outage: bounded auto-retry and manual retry coalesce.
7. iLink/WeChat upstream network failure remains identified as upstream and is not claimed as an MCP fix.

- [ ] **Step 2: Run all CLI channel tests**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel apps/cli/src/configure.test.ts apps/cli/src/bridge-update-contract.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository-wide tests and checks**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS. If an unrelated pre-existing failure appears, capture the exact command/error and prove the focused suites remain green; do not modify unrelated code.

- [ ] **Step 4: Review the diff for scope and secrets**

Run:

```bash
git diff --check
git diff --name-only
rg -n "access_token|refresh_token|client_secret|\.credentials\.json" apps/cli/src docs/local-agent-wechat-device-acceptance.md
```

Expected: no whitespace errors; only planned files; no new code that reads, logs, copies, or persists token values. References that explicitly forbid linking `.credentials.json` in a test are acceptable.

- [ ] **Step 5: Commit documentation and any test-only corrections**

```bash
git add docs/local-agent-wechat-device-acceptance.md apps/cli/src/channel
git commit -m "docs: add channel MCP recovery acceptance"
```

---

## Task 8: Bump the local installable artifact and verify upgrade compatibility

**Files:**

- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/version.ts`
- Create: `apps/web/public/cli/attention-0.3.12.mjs`
- Modify: `apps/web/public/cli/manifest.json`
- Remove through the sync script if repository policy requires: `apps/web/public/cli/attention-0.3.11.mjs`

- [ ] **Step 1: Add/update version consistency assertions**

Confirm existing tests require package version, runtime constant, manifest version, artifact filename, and artifact hash to agree. Extend only if one of those links is currently untested.

- [ ] **Step 2: Bump patch version from `0.3.11` to `0.3.12`**

Edit both source version declarations, then build/sync with the repository script:

```bash
pnpm cli-artifact:sync
```

Do not manually edit the bundled `.mjs` body or manifest hash.

- [ ] **Step 3: Verify artifact reproducibility and updater contract**

Run:

```bash
pnpm cli-artifact:check
pnpm exec vitest run apps/cli/src/bridge-update-contract.test.ts apps/cli/src/channel/bridge-updater.test.ts
```

Expected: PASS, with manifest `latest_version` and artifact filename set to `0.3.12` and SHA-256 matching the file.

- [ ] **Step 4: Run final build gates after generated artifact changes**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit the versioned artifact**

```bash
git add apps/cli/package.json apps/cli/src/version.ts apps/web/public/cli/manifest.json apps/web/public/cli/attention-0.3.12.mjs
git add -u apps/web/public/cli
git commit -m "chore(cli): prepare 0.3.12 MCP recovery artifact"
```

- [ ] **Step 6: Record the terminal state without releasing**

Report:

- implementation commit list and final `HEAD`;
- CLI version `0.3.12` and artifact hash verification;
- focused/full test, typecheck, and build results;
- live compatibility-gate result for single-login keyring reuse;
- remaining iLink/WeChat upstream limitation;
- explicit statement that nothing was pushed, published, deployed, or merged.

---

## Plan Self-Review Checklist

- [ ] Every positive MCP readiness transition requires structured `attention_get_my_account` evidence.
- [ ] Codex account auth and Attention MCP OAuth are classified independently.
- [ ] iLink, agent runtime, MCP, and queue health are reported independently.
- [ ] Chat remains available for `auth_required`, unreachable MCP, and retry backoff.
- [ ] Natural retry phrases are anchored and cannot hijack code/database retry requests.
- [ ] Recovery is single-flight, bounded, durable across restart, and stops retrying on auth-required.
- [ ] OAuth tokens never pass through Attention code, logs, state, tests, or commits.
- [ ] Credential reuse has an explicit supported-Codex compatibility gate and no insecure fallback.
- [ ] Version, manifest, bundle, hash, and updater contract are verified together.
- [ ] No deploy, publish, push, merge, admin-task file, or `.codex/` change is included.
