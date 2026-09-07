import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BRAIN_HISTORY_TURNS, PROCESSED_MESSAGE_RING_SIZE } from "./limits";
import { summaryRetryContext, settleReaderAttempt } from "./summary-retry";
import { buildFollowUpPrompt } from "./prompt";
import { handleInboundMessage } from "./pipeline";
import {
  appendHistory,
  channelStateDirectory,
  channelStatePath,
  clearChannelState,
  defaultChannelState,
  loadChannelState,
  rememberProcessedMessage,
  saveChannelState,
} from "./state";

describe("channel state persistence", () => {
  it("retains exact paused read facts across save/load for status-only explanations", async () => {
    const base = await makeTempBase(); const state = defaultChannelState();
    const job = { automaticAttempts: 0 as const, collectionId: "11111111-1111-4111-8111-111111111111", cycleStartedAt: "2026-09-04T07:00:00.000Z", lastFailureClass: null, nextAttemptAt: "2026-09-04T07:02:00.000Z", status: "scheduled" as const };
    state.summaryRetries.push(job);
    settleReaderAttempt(job, { collectionId: job.collectionId, attemptRef: "read-1", outcome: "blocked", methods: ["static", "browser"], failureCode: "verification_required", failureScope: "source", recovery: "needs_action", retryAfterMs: null }, new Date("2026-09-04T07:00:00.000Z"));
    await saveChannelState(state, base); const restored = await loadChannelState(base);
    expect(restored.summaryRetries[0]?.reader?.lastRead).toMatchObject({ methods: ["static", "browser"], failureCode: "verification_required", recovery: "needs_action" });
    const before = structuredClone(restored.summaryRetries);
    const prompt = buildFollowUpPrompt({ messageRef: "status-1", userMessage: "摘要现在怎样", retryContext: summaryRetryContext(restored) });
    expect(prompt).toContain("verification_required"); expect(prompt).toContain('"methods":["static","browser"]'); expect(prompt).toContain("needs_action");
    expect(prompt).not.toMatch(/temporary_text|https?:/u); expect(restored.summaryRetries).toEqual(before);
    let statusPrompt = "";
    const reply = await handleInboundMessage({
      state: restored, cwd: "/tmp", message: { fromUserId: "owner", contextToken: "context", itemList: [{ type: 1, text_item: { text: "这项收藏摘要现在怎样" } }], raw: {} },
      brain: { hostId: "codex", start: async () => {}, shutdown: async () => {}, runtimeSnapshot: () => ({ phase: "healthy", lastErrorCode: null, retryAttempt: 0 }), invoke: async () => { throw new Error("No unplanned read"); } },
      invokeBrain: async ({ prompt }) => {
        statusPrompt = prompt;
        return { ok: true, reply: "读取需要验证访问条件，自动重试已暂停；处理后可以再重试。", sessionId: null, resumeFailed: false, timedOut: false, collectionReplyControl: { kind: "recovery", collectionId: job.collectionId, enrichmentAction: "generate_summary", enrichmentCompleted: false, summaryStatus: "pending" } };
      },
    });
    expect(statusPrompt).toContain("verification_required"); expect(statusPrompt).toContain('"methods":["static","browser"]');
    expect(reply.replies.join("")).toContain("暂停"); expect(restored.summaryRetries).toEqual(before);
  });
  it("round trips versioned reader counters and preserves a paused dependency job", async () => {
    const base = await makeTempBase(); const state = defaultChannelState();
    state.summaryRetries.push({ automaticAttempts: 0, collectionId: "11111111-1111-4111-8111-111111111111", cycleStartedAt: "2026-09-04T07:00:00.000Z", lastFailureClass: null, nextAttemptAt: null, status: "paused",
      reader: { schemaVersion: 1, category: "dependency", budget: { contentRecoveries: 2, dependencyRecoveries: 4, dependencyStartedAt: 1788505200000, unknownRecoveries: 1, sequence: 7 } },
    });
    await saveChannelState(state, base);
    const restored = await loadChannelState(base);
    expect(restored.summaryRetries).toEqual(state.summaryRetries);
  });
  it("does not replay an indeterminate in-flight reader call after a process restart", async () => {
    const base = await makeTempBase(); const state = defaultChannelState();
    state.summaryRetries.push({ automaticAttempts: 0, collectionId: "11111111-1111-4111-8111-111111111111", cycleStartedAt: "2026-09-04T07:00:00.000Z", lastFailureClass: null, nextAttemptAt: "2026-09-04T07:00:05.000Z", status: "running", reader: { schemaVersion: 1, category: "dependency", budget: { contentRecoveries: 0, dependencyRecoveries: 4, dependencyStartedAt: 1788505200000, unknownRecoveries: 1, sequence: 5 } } });
    await saveChannelState(state, base);
    const restored = await loadChannelState(base);
    expect(restored.summaryRetries[0]).toMatchObject({ status: "paused", nextAttemptAt: null, reader: { interrupted: true, budget: { dependencyRecoveries: 4, unknownRecoveries: 1, sequence: 5 } } });
    expect(buildFollowUpPrompt({ messageRef: "after-restart", userMessage: "现在怎样", retryContext: summaryRetryContext(restored) })).toContain('"interrupted":true');
  });
  it("keeps a private original-state backup on first reader-budget write", async () => {
    const base = await makeTempBase(); const state = defaultChannelState();
    await saveChannelState(state, base); const original = await readFile(channelStatePath(base), "utf8");
    state.summaryRetries.push({ automaticAttempts: 0, collectionId: "11111111-1111-4111-8111-111111111111", cycleStartedAt: "2026-09-04T07:00:00.000Z", lastFailureClass: null, nextAttemptAt: null, status: "paused", reader: { schemaVersion: 1, category: "unknown", budget: { contentRecoveries: 0, dependencyRecoveries: 0, dependencyStartedAt: null, unknownRecoveries: 1, sequence: 1 } } });
    await saveChannelState(state, base); await saveChannelState(state, base);
    expect(await readFile(`${channelStatePath(base)}.pre-reader-v1.bak`, "utf8")).toBe(original);
    expect((await stat(`${channelStatePath(base)}.pre-reader-v1.bak`)).mode & 0o777).toBe(0o600);
  });
  const tempDirs: string[] = [];

  const makeTempBase = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "attention-channel-test-"));
    tempDirs.push(directory);
    return directory;
  };

  afterEach(async () => {
    for (const directory of tempDirs.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("returns defaults when no state file exists", async () => {
    const base = await makeTempBase();
    const state = await loadChannelState(base);
    expect(state).toEqual(defaultChannelState());
  });

  it("migrates state without a runtime checkpoint to safe stopped defaults", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    await saveChannelState(state, base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    delete raw.runtimeState;
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).runtimeState).toEqual({
      activeTurnMessageRef: null,
      lastErrorCode: null,
      lastHealthyAt: null,
      lastSuccessfulMessageAt: null,
      lastTransitionAt: null,
      nextRetryAt: null,
      phase: "stopped",
      retryAttempt: 0,
    });
  });

  it("migrates state without summary retries to an empty queue", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    delete raw.summaryRetries;
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect(Reflect.get(await loadChannelState(base), "summaryRetries")).toEqual(
      [],
    );
  });

  it("normalizes running summary retries and drops duplicate or unsafe shapes", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
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
      {
        automaticAttempts: 0,
        collectionId: "not-a-uuid",
        cycleStartedAt: "2026-09-04T08:00:00.000Z",
        lastFailureClass: null,
        nextAttemptAt: "2026-09-04T08:02:00.000Z",
        publicReadUrl: "https://secret.example/raw",
        status: "scheduled",
      },
      { publicReadUrl: "https://secret.example/raw" },
    ];
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).summaryRetries).toEqual([
      {
        automaticAttempts: 1,
        collectionId: "11111111-1111-4111-8111-111111111111",
        cycleStartedAt: "2026-09-04T08:00:00.000Z",
        lastFailureClass: "enrichment_incomplete",
        nextAttemptAt: "2026-09-04T08:10:00.000Z",
        status: "scheduled",
      },
    ]);
  });

  it("migrates state without an Attention MCP checkpoint to unknown", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    await saveChannelState(state, base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    delete raw.attentionMcp;
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect(Reflect.get(await loadChannelState(base), "attentionMcp")).toEqual({
      lastCheckedAt: null,
      lastErrorCode: null,
      lastReadyAt: null,
      nextRetryAt: null,
      retryAttempt: 0,
      status: "unknown",
    });
  });

  it("round-trips a bounded Attention MCP checkpoint", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    Reflect.set(state, "attentionMcp", {
      lastCheckedAt: "2026-09-03T08:00:00.000Z",
      lastErrorCode: "mcp_server_unreachable",
      lastReadyAt: "2026-09-03T07:00:00.000Z",
      nextRetryAt: "2026-09-03T08:00:03.000Z",
      retryAttempt: 2,
      status: "unreachable",
    });

    await saveChannelState(state, base);

    expect(Reflect.get(await loadChannelState(base), "attentionMcp")).toEqual({
      lastCheckedAt: "2026-09-03T08:00:00.000Z",
      lastErrorCode: "mcp_server_unreachable",
      lastReadyAt: "2026-09-03T07:00:00.000Z",
      nextRetryAt: "2026-09-03T08:00:03.000Z",
      retryAttempt: 2,
      status: "unreachable",
    });
  });

  it("normalizes an invalid MCP checkpoint without changing runtime state", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.runtimeState.phase = "healthy";
    await saveChannelState(state, base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.attentionMcp = {
      lastCheckedAt: "not-a-date",
      lastErrorCode: "Bearer private-token",
      lastReadyAt: false,
      nextRetryAt: "tomorrow",
      retryAttempt: -1,
      status: "waiting",
    };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    const loaded = await loadChannelState(base);
    expect(Reflect.get(loaded, "attentionMcp")).toEqual({
      lastCheckedAt: null,
      lastErrorCode: null,
      lastReadyAt: null,
      nextRetryAt: null,
      retryAttempt: 0,
      status: "unknown",
    });
    expect(loaded.runtimeState.phase).toBe("healthy");
  });

  it("persists a runtime phase checkpoint atomically", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.runtimeState = {
      activeTurnMessageRef:
        "msg-72cad190ed71ed0309138ac14e9982dbc21abd357ff0820d",
      lastErrorCode: "codex_runtime_crashed",
      lastHealthyAt: "2026-08-10T10:00:00.000Z",
      lastSuccessfulMessageAt: "2026-08-10T10:01:00.000Z",
      lastTransitionAt: "2026-08-10T10:02:00.000Z",
      nextRetryAt: "2026-08-10T10:02:04.000Z",
      phase: "restarting",
      retryAttempt: 3,
    };

    await saveChannelState(state, base);

    expect((await loadChannelState(base)).runtimeState).toEqual(
      state.runtimeState,
    );
  });

  it("normalizes an invalid runtime checkpoint to safe stopped defaults", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    await saveChannelState(state, base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.runtimeState = {
      activeTurnMessageRef: 12,
      lastErrorCode: ["secret"],
      lastHealthyAt: "not-a-date",
      lastSuccessfulMessageAt: false,
      lastTransitionAt: {},
      nextRetryAt: "tomorrow",
      phase: "unknown",
      retryAttempt: -1,
    };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).runtimeState).toEqual(
      defaultChannelState().runtimeState,
    );
  });

  it("keeps a valid phase while rejecting non-ISO checkpoint fields", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    await saveChannelState(state, base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.runtimeState = {
      activeTurnMessageRef: "raw-message-id",
      lastErrorCode: "Bearer secret-token",
      lastHealthyAt: "2026-08-10",
      lastSuccessfulMessageAt: null,
      lastTransitionAt: "2026-08-10T10:02:00.000Z",
      nextRetryAt: null,
      phase: "restarting",
      retryAttempt: 2,
    };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).runtimeState).toEqual({
      activeTurnMessageRef: null,
      lastErrorCode: null,
      lastHealthyAt: null,
      lastSuccessfulMessageAt: null,
      lastTransitionAt: "2026-08-10T10:02:00.000Z",
      nextRetryAt: null,
      phase: "restarting",
      retryAttempt: 2,
    });
  });

  it("does not persist raw message ids or diagnostic text in a checkpoint", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.runtimeState.phase = "degraded_runtime";
    state.runtimeState.activeTurnMessageRef = "raw-private-message-id";
    state.runtimeState.lastErrorCode = "Bearer secret-diagnostic";

    await saveChannelState(state, base);

    const persisted = await readFile(channelStatePath(base), "utf8");
    expect(persisted).not.toContain("raw-private-message-id");
    expect(persisted).not.toContain("secret-diagnostic");
    expect((await loadChannelState(base)).runtimeState).toMatchObject({
      activeTurnMessageRef: null,
      lastErrorCode: null,
      phase: "degraded_runtime",
    });
  });

  it("round-trips state through disk", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "ilink-token";
    state.accountId = "account-1";
    state.syncBuf = "cursor";
    state.contextTokens = { owner: "ctx" };
    state.ownerUserId = "owner";
    state.brainSession = {
      bridgeVersion: "0.3.13",
      hostId: "claude-code",
      permissionProfileSha256: "a".repeat(64),
      sessionId: "session-1",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };
    state.history = [{ content: "hi", role: "user" }];
    state.processedMessageIds = ["m-1"];
    state.runtimeReporter = {
      bindingId: "22222222-2222-4222-8222-222222222222",
      installationId: "11111111-1111-4111-8111-111111111111",
      runtimeClientFingerprint: "a".repeat(64),
    };
    state.summaryNotificationCursor =
      "2026-08-14T08:30:00.000Z|44444444-4444-4444-8444-444444444444";
    await saveChannelState(state, base);

    const loaded = await loadChannelState(base);
    expect(loaded).toEqual(state);
  });

  it("keeps a legacy brain session readable without inventing release identity", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.brainSession = {
      hostId: "codex",
      sessionId: "legacy-session",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };

    await saveChannelState(state, base);

    expect((await loadChannelState(base)).brainSession).toEqual(
      state.brainSession,
    );
  });

  it("keeps malformed release identity only as an untrusted legacy session", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.brainSession = {
      bridgeVersion: "latest",
      hostId: "codex",
      permissionProfileSha256: "Bearer secret",
      sessionId: "session-1",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).brainSession).toEqual({
      hostId: "codex",
      sessionId: "session-1",
      updatedAt: "2026-08-08T00:00:00.000Z",
    });
  });

  it("drops malformed summary notification cursors", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.summaryNotificationCursor = "Bearer private-token";
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).summaryNotificationCursor).toBeNull();
  });

  it("round-trips only a bounded account-verification checkpoint", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    Object.assign(state, {
      accountVerification: {
        hostId: "codex",
        mcpUrl: "https://attention.example/mcp",
        verifiedAt: "2026-08-11T07:00:00.000Z",
      },
    });

    await saveChannelState(state, base);

    expect(
      Reflect.get(await loadChannelState(base), "accountVerification"),
    ).toEqual({
      hostId: "codex",
      mcpUrl: "https://attention.example/mcp",
      verifiedAt: "2026-08-11T07:00:00.000Z",
    });
  });

  it("drops malformed account-verification checkpoints", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.accountVerification = {
      hostId: "codex",
      mcpUrl: "https://attention.example/mcp?credential=secret",
      verifiedAt: "2099-08-11T07:00:00.000Z",
    };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).accountVerification).toBeNull();
  });

  it("migrates and validates opaque Runtime reporter identifiers", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.runtimeReporter = {
      bindingId: "raw-provider-account-id",
      installationId: "11111111-1111-4111-8111-111111111111",
      runtimeClientFingerprint: "not-a-fingerprint",
    };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");

    expect((await loadChannelState(base)).runtimeReporter).toEqual({
      bindingId: null,
      installationId: "11111111-1111-4111-8111-111111111111",
      runtimeClientFingerprint: null,
    });
  });

  it("writes the state file with restrictive permissions", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    await chmod(channelStateDirectory(base), 0o755);
    await chmod(channelStatePath(base), 0o644);
    await saveChannelState(defaultChannelState(), base);
    const info = await stat(channelStatePath(base));
    expect(info.mode & 0o777).toBe(0o600);
    const directoryInfo = await stat(channelStateDirectory(base));
    expect(directoryInfo.mode & 0o777).toBe(0o700);
  });

  it("rejects corrupted state files instead of guessing", async () => {
    const base = await makeTempBase();
    const corrupted = defaultChannelState();
    await saveChannelState(corrupted, base);
    await writeFile(channelStatePath(base), "{not-json", "utf8");
    await expect(loadChannelState(base)).rejects.toThrow();
  });

  it("normalizes unknown session hosts away", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.brainSession = {
      hostId: "claude-code",
      sessionId: "s",
      updatedAt: "now",
    };
    await saveChannelState(state, base);
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.brainSession = { hostId: "other", sessionId: "s" };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");
    const loaded = await loadChannelState(base);
    expect(loaded.brainSession).toBeNull();
  });

  it("does not reload a persisted non-WeChat base URL", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.baseUrl = "https://credential-stealer.example";
    await saveChannelState(state, base);
    expect((await loadChannelState(base)).baseUrl).toBe(
      "https://ilinkai.weixin.qq.com",
    );
  });

  it("clears the state file on logout", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    await clearChannelState(base);
    expect(await loadChannelState(base)).toEqual(defaultChannelState());
    // Clearing twice must not throw.
    await clearChannelState(base);
  });

  it("bounds the processed-message ring", () => {
    const state = defaultChannelState();
    for (let index = 0; index < PROCESSED_MESSAGE_RING_SIZE + 50; index += 1) {
      rememberProcessedMessage(state, `m-${index}`);
    }
    expect(state.processedMessageIds).toHaveLength(
      PROCESSED_MESSAGE_RING_SIZE,
    );
    expect(state.processedMessageIds.at(-1)).toBe(
      `m-${PROCESSED_MESSAGE_RING_SIZE + 49}`,
    );
    expect(state.processedMessageIds[0]).toBe("m-50");
  });

  it("bounds the rolling history to the configured turns", () => {
    const state = defaultChannelState();
    for (let index = 0; index < BRAIN_HISTORY_TURNS + 10; index += 1) {
      appendHistory(state, `q${index}`, `a${index}`);
    }
    expect(state.history).toHaveLength(BRAIN_HISTORY_TURNS * 2);
    expect(state.history[0]).toEqual({
      content: "q10",
      role: "user",
    });
  });

  it("loads only the most recent twenty complete exchanges", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.history = Array.from({ length: 25 }, (_, index) => [
      { content: `q${index}`, role: "user" as const },
      { content: `a${index}`, role: "assistant" as const },
    ]).flat();
    await saveChannelState(state, base);

    const history = (await loadChannelState(base)).history;
    expect(history).toHaveLength(40);
    expect(history[0]).toEqual({ content: "q5", role: "user" });
    expect(history.at(-1)).toEqual({ content: "a24", role: "assistant" });
  });
});
