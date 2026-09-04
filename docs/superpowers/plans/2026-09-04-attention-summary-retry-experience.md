# Attention Summary Retry Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local Attention Bridge report incomplete summaries honestly, retry them durably at 2/10/30-minute intervals, and let the local Agent write natural but privacy-safe replies.

**Architecture:** Add a small pure scheduler around a minimal `collectionId`-only queue in `ChannelState`. Collection MCP observations remain the authority for queue transitions, while the message pipeline accepts the Agent's natural reply only after a local safety/semantic check. The existing serial Bridge loop runs due retries only while idle and healthy, and existing summary notifications remain the sole proactive success message.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Codex app-server, Claude Code stream-json, pnpm/esbuild.

**Spec:** `docs/superpowers/specs/2026-09-04-attention-summary-retry-experience-design.md`

## Global Constraints

- `summary_status=pending` means only that the shared Content has no ready summary; it must never be described as a server background job.
- Automatic retry delays are exactly 2 minutes, 10 minutes, and 30 minutes, with three automatic attempts per cycle.
- The first incomplete result replies immediately; the first two automatic failures are silent; success uses the existing summary notification; the third automatic failure sends one paused notification.
- Manual retries run immediately, do not consume or postpone an active automatic cycle, cancel it on success, and restart a paused cycle only when the result remains eligible.
- MCP OAuth/MCP availability and host Runtime failures do not consume summary retry attempts.
- Durable jobs contain no URL, title, page body, summary, tags, Cookie, OAuth data, or host transcript.
- Model-written collection replies must not expose URL, title, page body, summary, tags, IDs, tool names, tool parameters, or authentication data.
- The feature remains local to CLI/Bridge; do not add a server queue, Hosted Agent, new OAuth scope, or MCP contract change.
- Keep Codex and Claude Code behavior equivalent.
- Target CLI release is `0.3.15`; target Skill package version is `1.9.0`; MCP tool contract stays `1.6.0`.
- Do not push, publish, or deploy as part of implementation or verification.

---

### Task 1: Durable summary retry state and pure scheduler

**Files:**
- Modify: `apps/cli/src/channel/state.ts`
- Create: `apps/cli/src/channel/summary-retry.ts`
- Test: `apps/cli/src/channel/state.test.ts`
- Test: `apps/cli/src/channel/summary-retry.test.ts`

**Interfaces:**
- Produces: `SummaryRetryJob` persisted by `ChannelState.summaryRetries`, plus content-free `SummaryRetryContext` for prompts/status.
- Produces: `scheduleSummaryRetry`, `markSummaryRetryRunning`, `settleSummaryRetryAttempt`, `cancelSummaryRetry`, `nextDueSummaryRetry`, and `summaryRetryContext`.
- Consumes: only opaque collection UUIDs, clock timestamps, and safe result enums.

- [ ] **Step 1: Write failing state migration and privacy tests**

```ts
it("loads 0.3.14 state with an empty summary retry queue", async () => {
  const base = await makeTempBase();
  const state = defaultChannelState();
  await saveChannelState(state, base);
  const raw = JSON.parse(await readFile(channelStatePath(base), "utf8")) as Record<string, unknown>;
  delete raw.summaryRetries;
  await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");
  expect((await loadChannelState(base)).summaryRetries).toEqual([]);
});

it("normalizes running jobs after a crash and drops malformed or duplicate jobs", async () => {
  const base = await makeTempBase();
  const state = defaultChannelState();
  await saveChannelState(state, base);
  const raw = JSON.parse(await readFile(channelStatePath(base), "utf8")) as Record<string, unknown>;
  raw.summaryRetries = [
    {
      automaticAttempts: 1,
      collectionId: "11111111-1111-4111-8111-111111111111",
      cycleStartedAt: "2026-09-04T08:00:00.000Z",
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: "2026-09-04T08:10:00.000Z",
      status: "running",
    },
    {
      automaticAttempts: 2,
      collectionId: "11111111-1111-4111-8111-111111111111",
      cycleStartedAt: "2026-09-04T07:00:00.000Z",
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: "2026-09-04T07:30:00.000Z",
      status: "scheduled",
    },
    { publicReadUrl: "https://secret.example" },
  ];
  await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");
  expect((await loadChannelState(base)).summaryRetries).toEqual([{
    automaticAttempts: 1,
    collectionId: "11111111-1111-4111-8111-111111111111",
    cycleStartedAt: "2026-09-04T08:00:00.000Z",
    lastFailureClass: "enrichment_incomplete",
    nextAttemptAt: "2026-09-04T08:10:00.000Z",
    status: "scheduled",
  }]);
});
```

- [ ] **Step 2: Run the state tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/state.test.ts`

Expected: FAIL because `ChannelState` and normalization do not contain `summaryRetries`.

- [ ] **Step 3: Add the minimal persisted type and strict normalizer**

```ts
export interface SummaryRetryJob {
  automaticAttempts: 0 | 1 | 2 | 3;
  collectionId: string;
  cycleStartedAt: string;
  lastFailureClass: "enrichment_incomplete" | null;
  nextAttemptAt: string | null;
  status: "scheduled" | "running" | "paused";
}

export interface ChannelState {
  // existing fields...
  summaryRetries: SummaryRetryJob[];
}
```

Normalize UUIDs and ISO timestamps, discard unknown shapes, deduplicate by `collectionId`, convert `running` to `scheduled`, and never project extra properties into the returned job.

- [ ] **Step 4: Write failing scheduler tests**

```ts
it("uses the 2/10/30 minute schedule and pauses after attempt three", () => {
  const state = defaultChannelState();
  const collectionId = "11111111-1111-4111-8111-111111111111";
  const now = new Date("2026-09-04T08:00:00.000Z");
  scheduleSummaryRetry(state, collectionId, now);
  expect(state.summaryRetries[0]?.nextAttemptAt).toBe("2026-09-04T08:02:00.000Z");
  markSummaryRetryRunning(state, collectionId);
  settleSummaryRetryAttempt(state, collectionId, "incomplete", new Date("2026-09-04T08:02:00.000Z"));
  expect(state.summaryRetries[0]).toMatchObject({ automaticAttempts: 1, nextAttemptAt: "2026-09-04T08:12:00.000Z" });
  markSummaryRetryRunning(state, collectionId);
  settleSummaryRetryAttempt(state, collectionId, "incomplete", new Date("2026-09-04T08:12:00.000Z"));
  expect(state.summaryRetries[0]).toMatchObject({ automaticAttempts: 2, nextAttemptAt: "2026-09-04T08:42:00.000Z" });
  markSummaryRetryRunning(state, collectionId);
  expect(settleSummaryRetryAttempt(state, collectionId, "incomplete", new Date("2026-09-04T08:42:00.000Z"))).toBe("paused");
});
```

Also cover: success/terminal cancellation, dependency failure preserving attempts, manual failure preserving an active schedule, manual success cancellation, paused manual failure starting a new cycle, due ordering, 32-job limit, and oldest-paused eviction.

- [ ] **Step 5: Run scheduler tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/summary-retry.test.ts`

Expected: FAIL because `summary-retry.ts` does not exist.

- [ ] **Step 6: Implement the pure scheduler**

```ts
export const SUMMARY_RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

export type SummaryRetryAttemptResult =
  | "completed"
  | "terminal"
  | "incomplete"
  | "dependency_failure";

export interface SummaryRetryContext {
  readonly active: number;
  readonly nextAttemptAt: string | null;
  readonly paused: number;
  readonly running: number;
}

export function nextDueSummaryRetry(
  state: ChannelState,
  now: Date,
): SummaryRetryJob | null;

export function settleSummaryRetryAttempt(
  state: ChannelState,
  collectionId: string,
  result: SummaryRetryAttemptResult,
  now: Date,
): "cancelled" | "scheduled" | "paused";

export function summaryRetryContext(state: ChannelState): SummaryRetryContext;
```

Keep every mutation deterministic and side-effect-free apart from the supplied state object; inject `Date` in every clock-sensitive function.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm vitest run apps/cli/src/channel/state.test.ts apps/cli/src/channel/summary-retry.test.ts`

Expected: PASS.

```bash
git add apps/cli/src/channel/state.ts apps/cli/src/channel/state.test.ts apps/cli/src/channel/summary-retry.ts apps/cli/src/channel/summary-retry.test.ts
git commit -m "feat(cli): persist summary retry jobs"
```

---

### Task 2: Authoritative collection signals and safe natural replies

**Files:**
- Modify: `apps/cli/src/channel/brain.ts`
- Modify: `apps/cli/src/channel/collection-reply-control.ts`
- Test: `apps/cli/src/channel/collection-reply-control.test.ts`
- Modify: `apps/cli/src/channel/brains/codex-resident.ts`
- Modify: `apps/cli/src/channel/brains/codex-resident.test.ts`
- Modify: `apps/cli/src/channel/brains/claude-resident.ts`
- Modify: `apps/cli/src/channel/brains/claude-resident.test.ts`

**Interfaces:**
- Produces: `CollectionReplyControl.collectionId` for established and recovery results.
- Produces: `collectionControlResult(control)` returning `completed | ready | retryable_incomplete | terminal | unconfirmed`.
- Produces: `safeCollectionReply(control, candidate, context)` that returns checked Agent prose or a content-free fallback.
- Produces: transient `BrainOutcome.collectionReplySensitiveFragments`, populated from URL/title/summary/tag/ID strings in Attention MCP results and discarded after pipeline safety checking.
- Consumes: Collection MCP result payloads observed transiently by either resident host.

- [ ] **Step 1: Write failing structured-control tests**

```ts
const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";

expect(applyAttentionToolResult(null, "attention_collect_content", {
  collection_id: COLLECTION_ID,
  enrichment_action: "generate_summary",
  status: "accepted",
})).toMatchObject({ collectionId: COLLECTION_ID, kind: "established" });

expect(applyAttentionToolResult(null, "attention_get_collection_status", {
  collection: { collection_id: COLLECTION_ID },
  content: {
    enrichment_action: "generate_summary",
    public_read_url: "https://example.org/article",
    summary_status: "pending",
  },
})).toMatchObject({ collectionId: COLLECTION_ID, kind: "recovery" });
```

Require a valid UUID for a retryable control; missing/malformed IDs become `unconfirmed` and cannot create a job. Verify Codex and Claude observations preserve the same safe UUID in the control, expose sensitive MCP strings only through the transient safety-evidence field, and never put URL/title/summary/tag data in durable control or state.

- [ ] **Step 2: Run control and resident tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/collection-reply-control.test.ts apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/claude-resident.test.ts`

Expected: FAIL because controls do not carry `collectionId`.

- [ ] **Step 3: Implement control classification**

```ts
export type CollectionControlResult =
  | "completed"
  | "ready"
  | "retryable_incomplete"
  | "terminal"
  | "unconfirmed";

export function collectionControlResult(
  control: CollectionReplyControl,
): CollectionControlResult;
```

Map `generate_summary + enrichmentCompleted` to completed, `generate_summary + !enrichmentCompleted` to retryable, `reuse_summary/ready` to ready, known hidden/unavailable/none states to terminal, and fixed/unparseable results to unconfirmed.

- [ ] **Step 4: Write failing natural-reply safety tests**

```ts
const control: CollectionReplyControl = {
  collectionId: "11111111-1111-4111-8111-111111111111",
  collectionStatus: "accepted",
  enrichmentAction: "generate_summary",
  enrichmentCompleted: false,
  kind: "established",
};

expect(safeCollectionReply(control, "收藏成功，这次没补全摘要，约 2 分钟后会自动重试。", {
  phase: "initial_incomplete",
  sensitiveFragments: [],
})).toEqual({ accepted: true, text: "收藏成功，这次没补全摘要，约 2 分钟后会自动重试。" });

expect(safeCollectionReply(control, "正文见 https://example.org，摘要内容如下", {
  phase: "initial_incomplete",
  sensitiveFragments: ["https://example.org"],
})).toMatchObject({ accepted: false, reason: "reply_contains_url" });
```

Cover empty/oversized replies, email, UUID, code fences, JSON/tool syntax, `mcp__`, Attention tool names, content-bearing labels, direct or normalized overlap with a sensitive MCP fragment, and incomplete replies that omit both failure truth and retry timing. Confirm fallback text contains no payload and does not claim work is running.

- [ ] **Step 5: Run the safety tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/collection-reply-control.test.ts`

Expected: FAIL because the current implementation always replaces Agent prose.

- [ ] **Step 6: Implement checked natural replies with fallback only on rejection**

```ts
export interface SafeCollectionReplyResult {
  readonly accepted: boolean;
  readonly reason: CollectionReplyRejectionReason | null;
  readonly text: string;
}

export function safeCollectionReply(
  control: CollectionReplyControl,
  candidate: string,
  context: {
    readonly phase: "ordinary" | "initial_incomplete" | "paused" | "terminal";
    readonly sensitiveFragments: readonly string[];
  },
): SafeCollectionReplyResult;
```

Normalize and trim candidate text, enforce `MAXIMUM_REPLY_CHARS`, reject unsafe forms and sensitive-fragment overlap with stable reason codes, and choose a state-derived content-free fallback only when rejected. Bound fragment count/length before comparison. Never log the candidate/fragments or persist rejected prose.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm vitest run apps/cli/src/channel/collection-reply-control.test.ts apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/claude-resident.test.ts`

Expected: PASS.

```bash
git add apps/cli/src/channel/brain.ts apps/cli/src/channel/collection-reply-control.ts apps/cli/src/channel/collection-reply-control.test.ts apps/cli/src/channel/brains/codex-resident.ts apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/claude-resident.ts apps/cli/src/channel/brains/claude-resident.test.ts
git commit -m "feat(cli): allow safe natural collection replies"
```

---

### Task 3: Inbound pipeline queue transitions and honest status context

**Files:**
- Modify: `apps/cli/src/channel/prompt.ts`
- Modify: `apps/cli/src/channel/pipeline.ts`
- Test: `apps/cli/src/channel/prompt.test.ts`
- Test: `apps/cli/src/channel/pipeline.test.ts`

**Interfaces:**
- Consumes: `CollectionReplyControl`, `safeCollectionReply`, and Task 1 scheduler functions.
- Produces: initial/manual queue transitions inside `handleInboundMessage`.
- Produces: `buildSummaryRetryPrompt` for internal automatic turns and safe retry-state context for user follow-ups.

- [ ] **Step 1: Write failing prompt tests**

```ts
const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";

expect(buildFollowUpPrompt({
  messageRef: "msg-1",
  retryContext: { active: 1, nextAttemptAt: "2026-09-04T08:02:00.000Z", paused: 0, running: 0 },
  userMessage: "在做了吗",
})).toMatch(/pending 只表示摘要未完成，不代表后台任务正在运行/u);

expect(buildSummaryRetryPrompt({
  automaticAttempt: 1,
  collectionId: COLLECTION_ID,
  retryRef: "summary-retry-0123456789abcdef0123456789abcdef0123456789abcdef",
})).toMatch(/先调用 attention_get_collection_status/u);

expect(buildSummaryRetryNoticePrompt({ phase: "paused" })).not.toMatch(
  new RegExp(COLLECTION_ID, "u"),
);
```

The automatic work prompt must require the exact returned `public_read_url`, prohibit history/URL guessing, define the content-free reply policy, and state that dependency failures must be reported through tool evidence rather than invented prose. The notice-composer prompt receives only a safe phase enum (`paused` or `terminal`) and must forbid tools; it receives no collection ID, URL, title, summary, tags, or previous Agent text.

- [ ] **Step 2: Run prompt tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/prompt.test.ts`

Expected: FAIL because retry prompts/context do not exist.

- [ ] **Step 3: Implement prompt builders and update channel policy**

```ts
export function buildSummaryRetryPrompt(input: {
  readonly automaticAttempt: 1 | 2 | 3;
  readonly collectionId: string;
  readonly retryRef: string;
}): string;

export function buildSummaryRetryNoticePrompt(input: {
  readonly phase: "paused" | "terminal";
}): string;
```

Change reply guidance from fixed acknowledgements to natural, short, content-free status prose; explicitly teach the Agent that the Bridge—not `summary_status`—owns scheduled/running/paused state.

- [ ] **Step 4: Write failing inbound transition tests**

```ts
it("queues the first incomplete summary and keeps the safe Agent reply", async () => {
  const state = defaultChannelState();
  const output = await handleInboundMessage({
    brain: fakeBrain("codex"),
    cwd: "/tmp",
    invokeBrain: async () => ({
      ...okOutcome("收藏成功，这次没补全摘要，约 2 分钟后会自动重试。"),
      collectionReplyControl: {
        collectionId: "11111111-1111-4111-8111-111111111111",
        collectionStatus: "accepted",
        enrichmentAction: "generate_summary",
        enrichmentCompleted: false,
        kind: "established",
      },
      collectionReplySensitiveFragments: [],
    }),
    message: textMessage("请收藏这篇文章"),
    state,
  });
  expect(output.replies).toEqual(["收藏成功，这次没补全摘要，约 2 分钟后会自动重试。"]);
  expect(state.summaryRetries[0]).toMatchObject({ collectionId: "11111111-1111-4111-8111-111111111111", automaticAttempts: 0, status: "scheduled" });
});
```

Also cover completed/ready/terminal cancellation, unconfirmed result not enqueueing, active manual failure preserving schedule, paused manual failure starting a new cycle, manual success cancelling, unsafe prose falling back, and ordinary chat remaining unchanged.

- [ ] **Step 5: Run pipeline tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/pipeline.test.ts`

Expected: FAIL because the pipeline does not mutate `summaryRetries` and still always fixes collection replies.

- [ ] **Step 6: Implement inbound transitions**

After a successful brain turn, classify the structured control before completing the inbound message. Persisting remains the caller's responsibility, but `handleInboundMessage` must mutate state before it returns a reply claiming that retry was scheduled. Pass a safe queue summary into first/follow-up/replay prompts without exposing collection IDs or content fields.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm vitest run apps/cli/src/channel/prompt.test.ts apps/cli/src/channel/pipeline.test.ts`

Expected: PASS.

```bash
git add apps/cli/src/channel/prompt.ts apps/cli/src/channel/prompt.test.ts apps/cli/src/channel/pipeline.ts apps/cli/src/channel/pipeline.test.ts
git commit -m "feat(cli): schedule incomplete summaries from chat"
```

---

### Task 4: Idle Bridge automatic retry executor and notifications

**Files:**
- Modify: `apps/cli/src/channel/channel-command.ts`
- Test: `apps/cli/src/channel/channel-command.test.ts`
- Modify: `apps/cli/src/channel/queue.ts`
- Test: `apps/cli/src/channel/queue.test.ts`

**Interfaces:**
- Consumes: `nextDueSummaryRetry`, `markSummaryRetryRunning`, `settleSummaryRetryAttempt`, `buildSummaryRetryPrompt`, `BrainAdapter.invoke`, and existing `pendingOutbound`.
- Produces: exported test seam `processDueSummaryRetry(...)` returning `idle | completed | scheduled | paused | dependency_failure`.
- Produces: deterministic paused outbound ID `` `summary-retry-paused:${collectionId}:${cycleStartedAt}` ``.

- [ ] **Step 1: Write failing executor tests**

```ts
it("marks due work running before invocation and schedules the next delay after incomplete", async () => {
  const state = defaultChannelState();
  const collectionId = "11111111-1111-4111-8111-111111111111";
  const now = new Date("2026-09-04T08:02:00.000Z");
  scheduleSummaryRetry(state, collectionId, new Date("2026-09-04T08:00:00.000Z"));
  const persistedSnapshots: ChannelState[] = [];
  const persist = async (): Promise<void> => {
    persistedSnapshots.push(structuredClone(state));
  };
  const brain: BrainAdapter = {
    hostId: "codex",
    invoke: async () => ({
      collectionReplyControl: {
        collectionId,
        enrichmentAction: "generate_summary",
        enrichmentCompleted: false,
        kind: "recovery",
        summaryStatus: "pending",
      },
      collectionReplySensitiveFragments: [],
      ok: true,
      reply: "这次仍未补全摘要。",
      resumeFailed: false,
      sessionId: "session-1",
      timedOut: false,
    }),
    runtimeSnapshot: () => ({ lastErrorCode: null, phase: "healthy", retryAttempt: 0 }),
    shutdown: async () => undefined,
    start: async () => undefined,
  };
  const result = await processDueSummaryRetry({ brain, cwd: "/tmp/channel", now, persist, state });
  expect(persistedSnapshots[0]?.summaryRetries[0]?.status).toBe("running");
  expect(result).toBe("scheduled");
  expect(state.summaryRetries[0]).toMatchObject({ automaticAttempts: 1, status: "scheduled" });
  expect(state.pendingOutbound).toEqual([]);
});
```

Add tests for: status→read→submit completion cancellation, `ready` cancellation, terminal cancellation with one safe terminal notice, first/second silent failure, third failure adding exactly one paused outbound, MCP failure preserving attempt count, Runtime timeout preserving attempt count, crash-recovered `running`, missing owner/context retaining paused state without leaking, and no invocation while inbound/outbound work exists or health is degraded. The paused/terminal notice test must prove a second disposable AI invocation receives only `buildSummaryRetryNoticePrompt({ phase })` with `sessionId: null`, and its returned session is not stored.

- [ ] **Step 2: Run command tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/channel-command.test.ts`

Expected: FAIL because there is no due-job executor.

- [ ] **Step 3: Implement one-job serial execution**

```ts
export async function processDueSummaryRetry(input: {
  readonly brain: BrainAdapter;
  readonly cwd: string;
  readonly now: Date;
  readonly persist: () => Promise<void>;
  readonly state: ChannelState;
}): Promise<"idle" | "completed" | "scheduled" | "paused" | "dependency_failure">;
```

The function must mark/persist `running` before invoking, use a deterministic SHA-256 retry reference rather than user text, classify only structured MCP evidence, and never append the automatic prompt/reply to `state.history`. On the third incomplete attempt or a newly observed terminal state, run one disposable `sessionId: null` notice-composer turn containing only the safe phase; safety-check that prose with an empty fragment set, discard its session, and enqueue the content-free fallback if composition fails.

- [ ] **Step 4: Integrate the executor into the service loop**

Call it after `flushPendingOutbound` and `processPendingInbound`, before update staging and before the next iLink long poll, only when:

```ts
runtime.state.pendingInbound.length === 0 &&
runtime.state.pendingOutbound.length === 0 &&
runtime.state.attentionMcp.status === "ready" &&
runtime.state.runtimeState.phase === "healthy" &&
Boolean(runtime.client.token)
```

On dependency failure, use the MCP/Runtime checkpoint's `nextRetryAt`; when it is absent, delay the next eligibility check by 60 seconds without changing `automaticAttempts`, preventing a tight loop.

- [ ] **Step 5: Add status observability and deduplicated paused outbound**

Extend the local `状态` reply with active/running/paused retry counts and the nearest safe timestamp. Update `enqueueOutbound` tests to prove the deterministic paused ID prevents duplicate messages after a crash.

- [ ] **Step 6: Run channel regression tests and commit**

Run: `pnpm vitest run apps/cli/src/channel`

Expected: PASS for scheduler, state, prompt, pipeline, resident hosts, notifications, queue, recovery, updater, and command loop.

```bash
git add apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/queue.ts apps/cli/src/channel/queue.test.ts
git commit -m "feat(cli): run durable summary retries"
```

---

### Task 5: Versioned CLI and Skill artifacts

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/version.ts`
- Modify: `apps/cli/src/main.test.ts`
- Modify: `apps/cli/src/channel/prompt.ts`
- Modify: `packages/contracts/src/agent-installation.ts`
- Modify: `apps/web/src/server/attention-tool-registry.ts`
- Modify: `apps/web/public/skills/attention/SKILL.md`
- Modify: `apps/web/public/skills/attention/INSTALL.md`
- Generate: `apps/web/public/skills/attention/installations/v1/**`
- Generate: `apps/web/public/skills/attention/bundles/attention-workbuddy-1.9.0.zip`
- Generate: `apps/web/public/cli/attention-0.3.15.mjs`
- Generate: `apps/web/public/cli/manifest.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: CLI release `0.3.15`, Skill package `1.9.0`, unchanged tool contract `1.6.0`, and synchronized public artifacts.
- Consumes: repository artifact sync scripts; do not hand-edit generated installation JSON or bundled CLI contents.

- [ ] **Step 1: Write/update version assertions first**

```ts
it("reports the 0.3.15 Bridge release identity", () => {
  expect(ATTENTION_CLI_VERSION).toBe("0.3.15");
});
```

Update Skill/version contract tests to expect `1.9.0` while retaining `ATTENTION_SKILL_TOOL_CONTRACT_VERSION === "1.6.0"`.

- [ ] **Step 2: Run version tests and verify RED**

Run: `pnpm vitest run apps/cli/src/main.test.ts packages/contracts/src/agent-installation.test.ts apps/web/src/server/attention-tool-registry.test.ts`

Expected: FAIL on old CLI/Skill versions.

- [ ] **Step 3: Update source versions and public prose**

Set `apps/cli/package.json` and `ATTENTION_CLI_VERSION` to `0.3.15`; set `SKILL_REPORT_VERSION` and `ATTENTION_SKILL_PACKAGE_VERSION` to `1.9.0`; add `1.9.0` to the registry's accepted client versions. Document that Bridge-local retry state—not server `pending`—is authoritative, and that 2/10/30-minute retries require the local Bridge to remain available.

- [ ] **Step 4: Synchronize generated artifacts**

Run:

```bash
pnpm install --lockfile-only
pnpm agent-installations:sync
pnpm capabilities:sync
pnpm cli-artifact:sync
```

Expected: generated installation hashes, bundle path, CLI manifest, and bundled CLI all reference the new versions; capability MCP contract content is unchanged except any hash-derived installation references.

- [ ] **Step 5: Verify artifact consistency and commit**

Run:

```bash
pnpm agent-installations:check
pnpm capabilities:check
pnpm cli-artifact:check
```

Expected: all checks PASS.

```bash
git add apps/cli packages/contracts apps/web/public apps/web/src/server/attention-tool-registry.ts pnpm-lock.yaml
git commit -m "chore: prepare Attention CLI 0.3.15"
```

---

### Task 6: Full verification and security review

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- Consumes: all earlier task outputs.
- Produces: evidence that privacy, state recovery, host parity, build, and artifacts are release-ready without publishing.

- [ ] **Step 1: Run focused privacy and lifecycle tests**

Run:

```bash
pnpm vitest run apps/cli/src/channel/state.test.ts apps/cli/src/channel/summary-retry.test.ts apps/cli/src/channel/collection-reply-control.test.ts apps/cli/src/channel/prompt.test.ts apps/cli/src/channel/pipeline.test.ts apps/cli/src/channel/brains/codex-resident.test.ts apps/cli/src/channel/brains/claude-resident.test.ts apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/notifications.test.ts apps/cli/src/channel/queue.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run static checks and build**

Run:

```bash
pnpm --filter @attention/cli typecheck
pnpm typecheck
pnpm lint
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Run repository tests and artifact checks**

Run:

```bash
pnpm test
pnpm agent-installations:check
pnpm capabilities:check
pnpm cli-artifact:check
git diff --check
```

Expected: PASS; any environment-only test failure must be rerun in isolation and reported with exact evidence.

- [ ] **Step 4: Inspect the durable state and logs for leakage**

Use tests with sentinel values such as `https://secret.example/raw`, `RAW_TITLE_SENTINEL`, `RAW_BODY_SENTINEL`, and `RAW_TAG_SENTINEL`; assert none appear in serialized `ChannelState`, retry logs, or paused outbound text. Confirm only `collectionId`, timing, attempt count, status, and `enrichment_incomplete` persist.

- [ ] **Step 5: Perform the local real-Bridge acceptance check**

Start the already configured local Bridge without changing deployment state. Send one publicly readable article and one upstream-restricted WeChat article through the existing ClawBot conversation. Confirm the readable item produces one completion notification; confirm the restricted item reports the first failure immediately, remains silent at the first two automatic failures, and reports a paused state after the third. If a 42-minute live wait is impractical, use the injected test clock for the timing proof and perform one real retry cycle for network/host integration evidence; report that limitation explicitly.

- [ ] **Step 6: Review the final diff and commit verification fixes if needed**

Run:

```bash
git status --short
git diff --stat HEAD~4..HEAD
git log --oneline -6
```

Expected: only summary retry behavior, tests, documented Skill wording, versions, and generated artifacts are present; `.codex/` and unrelated worktree changes remain untouched.

If verification exposes a defect, return to the originating task's named source/test pair, write the failing regression test, implement the smallest fix, rerun that task's command, and create `fix(cli): close summary retry verification gaps` using only that pair. If verification leaves no working-tree changes, do not create an empty commit.
