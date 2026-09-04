import { describe, expect, it } from "vitest";

import { ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256 } from "../bridge-update-contract";
import { ATTENTION_CLI_VERSION } from "../version";
import type { BrainAdapter, BrainOutcome } from "./brain";
import { NON_TEXT_REPLY, RESET_REPLY } from "./limits";
import {
  buildMessageRef,
  handleInboundMessage,
  matchControlCommand,
  splitReply,
} from "./pipeline";
import { defaultChannelState } from "./state";

const currentBrainSession = (
  hostId: BrainAdapter["hostId"],
  sessionId: string,
) => ({
  bridgeVersion: ATTENTION_CLI_VERSION,
  hostId,
  permissionProfileSha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
  sessionId,
  updatedAt: "2026-09-04T00:00:00.000Z",
});

const textMessage = (
  text: string,
  overrides: Record<string, unknown> = {},
) => ({
  contextToken: "ctx-1",
  fromUserId: "owner",
  itemList: [{ text_item: { text }, type: 1 }],
  raw: { context_token: "ctx-1", from_user_id: "owner", ...overrides },
});

const okOutcome = (reply: string, sessionId = "session-1"): BrainOutcome => ({
  ok: true,
  reply,
  resumeFailed: false,
  sessionId,
  timedOut: false,
});

const controlledOutcome = (
  reply: string,
  control: {
    readonly collectionStatus:
      | "accepted"
      | "already_collected"
      | "merged_with_existing_content";
    readonly enrichmentAction: "generate_summary" | "reuse_summary" | "none";
    readonly enrichmentCompleted: boolean;
  },
): BrainOutcome =>
  ({
    ...okOutcome(reply),
    collectionReplyControl: {
      collectionId: "11111111-1111-4111-8111-111111111111",
      kind: "established",
      ...control,
    },
  }) as BrainOutcome;

const recoveryOutcome = (
  reply: string,
  input: {
    readonly enrichmentAction: "generate_summary" | "reuse_summary" | "none";
    readonly enrichmentCompleted: boolean;
    readonly summaryStatus: "hidden" | "pending" | "ready" | "unavailable";
  },
): BrainOutcome => ({
  ...okOutcome(reply),
  collectionReplyControl: {
    collectionId: "11111111-1111-4111-8111-111111111111",
    kind: "recovery",
    ...input,
  },
  collectionReplySensitiveFragments: [],
});

const fakeBrain = (
  hostId: BrainAdapter["hostId"],
  reply = "ok",
): BrainAdapter => ({
  hostId,
  invoke: async () => okOutcome(reply),
  runtimeSnapshot: () => ({
    lastErrorCode: null,
    phase: "healthy",
    retryAttempt: 0,
  }),
  shutdown: async () => {},
  start: async () => {},
});

describe("handleInboundMessage", () => {
  it("queues an incomplete summary before returning the safe natural reply", async () => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () =>
        controlledOutcome(
          "收藏成功，这次没补全摘要，约 2 分钟后会自动重试。",
          {
            collectionStatus: "accepted",
            enrichmentAction: "generate_summary",
            enrichmentCompleted: false,
          },
        ),
      message: textMessage("请收藏这篇文章"),
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      state,
    });

    expect(output.replies).toEqual([
      "收藏成功，这次没补全摘要，约 2 分钟后会自动重试。",
    ]);
    expect(output.collectionReplyRejectionReason).toBeUndefined();
    expect(state.summaryRetries).toEqual([
      {
        automaticAttempts: 0,
        collectionId: "11111111-1111-4111-8111-111111111111",
        cycleStartedAt: "2026-09-04T08:00:00.000Z",
        lastFailureClass: null,
        nextAttemptAt: "2026-09-04T08:02:00.000Z",
        status: "scheduled",
      },
    ]);
  });

  it("reports a full local retry queue without claiming retry was scheduled", async () => {
    const state = defaultChannelState();
    for (let index = 0; index < 32; index += 1) {
      state.summaryRetries.push({
        automaticAttempts: 0,
        collectionId: `aaaaaaaa-aaaa-4aaa-8aaa-${(index + 1)
          .toString(16)
          .padStart(12, "0")}`,
        cycleStartedAt: "2026-09-04T07:00:00.000Z",
        lastFailureClass: null,
        nextAttemptAt: "2026-09-04T08:02:00.000Z",
        status: "scheduled",
      });
    }
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () =>
        controlledOutcome(
          "收藏成功，这次没补全摘要，约 2 分钟后会自动重试。",
          {
            collectionStatus: "accepted",
            enrichmentAction: "generate_summary",
            enrichmentCompleted: false,
          },
        ),
      message: textMessage("请收藏"),
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      state,
    });

    expect(output.replies).toEqual([
      "已收藏，但本地重试队列已满，暂时无法安排自动重试。",
    ]);
    expect(output.collectionReplyRejectionReason).toBe(
      "reply_retry_queue_full",
    );
    expect(state.summaryRetries).toHaveLength(32);
  });

  it("keeps an active retry schedule when a manual attempt remains incomplete", async () => {
    const state = defaultChannelState();
    state.summaryRetries.push({
      automaticAttempts: 1,
      collectionId: "11111111-1111-4111-8111-111111111111",
      cycleStartedAt: "2026-09-04T07:00:00.000Z",
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: "2026-09-04T08:10:00.000Z",
      status: "scheduled",
    });

    await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () =>
        recoveryOutcome("这次仍没补全摘要，原定自动重试会继续。", {
          enrichmentAction: "generate_summary",
          enrichmentCompleted: false,
          summaryStatus: "pending",
        }),
      message: textMessage("再补一下摘要"),
      now: () => new Date("2026-09-04T08:01:00.000Z"),
      state,
    });

    expect(state.summaryRetries[0]).toMatchObject({
      automaticAttempts: 1,
      cycleStartedAt: "2026-09-04T07:00:00.000Z",
      nextAttemptAt: "2026-09-04T08:10:00.000Z",
    });
  });

  it("starts a new automatic cycle when a manual attempt follows a pause", async () => {
    const state = defaultChannelState();
    state.summaryRetries.push({
      automaticAttempts: 3,
      collectionId: "11111111-1111-4111-8111-111111111111",
      cycleStartedAt: "2026-09-04T07:00:00.000Z",
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: null,
      status: "paused",
    });

    await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () =>
        recoveryOutcome("这次仍没补全摘要，约 2 分钟后会重新自动重试。", {
          enrichmentAction: "generate_summary",
          enrichmentCompleted: false,
          summaryStatus: "pending",
        }),
      message: textMessage("再试试补摘要"),
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      state,
    });

    expect(state.summaryRetries[0]).toMatchObject({
      automaticAttempts: 0,
      cycleStartedAt: "2026-09-04T08:00:00.000Z",
      nextAttemptAt: "2026-09-04T08:02:00.000Z",
      status: "scheduled",
    });
  });

  it.each([
    ["completed", controlledOutcome("摘要已经补全。", {
      collectionStatus: "accepted",
      enrichmentAction: "generate_summary",
      enrichmentCompleted: true,
    })],
    ["ready", recoveryOutcome("摘要已经就绪。", {
      enrichmentAction: "reuse_summary",
      enrichmentCompleted: false,
      summaryStatus: "ready",
    })],
    ["terminal", recoveryOutcome("这项内容不再符合摘要补全条件。", {
      enrichmentAction: "none",
      enrichmentCompleted: false,
      summaryStatus: "unavailable",
    })],
  ] as const)("cancels retry state after a %s inbound result", async (_label, outcome) => {
    const state = defaultChannelState();
    state.summaryRetries.push({
      automaticAttempts: 1,
      collectionId: "11111111-1111-4111-8111-111111111111",
      cycleStartedAt: "2026-09-04T07:00:00.000Z",
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: "2026-09-04T08:10:00.000Z",
      status: "scheduled",
    });
    await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => outcome,
      message: textMessage("看看摘要状态"),
      state,
    });
    expect(state.summaryRetries).toEqual([]);
  });

  it.each(["codex", "claude-code"] as const)(
    "replaces adversarial direct enrichment output with a fixed safe reply for %s",
    async (hostId) => {
      const state = defaultChannelState();
      const adversarial =
        "已收藏《RAW TITLE》 https://example.com/raw BODY SENTINEL SUMMARY SENTINEL #TAG_SENTINEL";
      const output = await handleInboundMessage({
        brain: fakeBrain(hostId),
        cwd: "/tmp",
        invokeBrain: async () =>
          controlledOutcome(adversarial, {
            collectionStatus: "accepted",
            enrichmentAction: "generate_summary",
            enrichmentCompleted: true,
          }),
        message: textMessage("https://example.com/raw"),
        state,
      });

      expect(output.replies).toEqual(["已收藏，摘要已补全。"]);
      expect(output.collectionReplyRejectionReason).toBe(
        "reply_contains_url",
      );
      expect(output.replies.join(" ")).not.toMatch(
        /RAW TITLE|https?:\/\/|BODY SENTINEL|SUMMARY SENTINEL|TAG_SENTINEL/u,
      );
      expect(state.history.at(-1)?.content).toBe("已收藏，摘要已补全。");
    },
  );

  it.each([
    ["codex", "generate_summary", true, "已收藏，摘要已补全。"],
    ["codex", "generate_summary", false, "已收藏，但这次没有补全摘要；约 2 分钟后会自动重试。"],
    ["codex", "reuse_summary", false, "已收藏，已使用现有摘要。"],
    ["claude-code", "generate_summary", true, "已收藏，摘要已补全。"],
    ["claude-code", "generate_summary", false, "已收藏，但这次没有补全摘要；约 2 分钟后会自动重试。"],
    ["claude-code", "reuse_summary", false, "已收藏，已使用现有摘要。"],
  ] as const)(
    "falls back safely for adversarial selected-result prose on %s %s completed=%s",
    async (hostId, enrichmentAction, enrichmentCompleted, expected) => {
      const state = defaultChannelState();
      state.history = [
        { content: "share with two links", role: "user" },
        { content: "请选择 1 或 2", role: "assistant" },
      ];
      state.brainSession = currentBrainSession(hostId, "selected-session");
      const output = await handleInboundMessage({
        brain: fakeBrain(hostId),
        cwd: "/tmp",
        invokeBrain: async () =>
          controlledOutcome(
            "RAW TITLE https://example.com BODY SUMMARY #PRIVATE_TAG",
            {
              collectionStatus: "accepted",
              enrichmentAction,
              enrichmentCompleted,
            },
          ),
        message: textMessage("1"),
        state,
      });

      expect(output.replies).toEqual([expected]);
      expect(output.replies.join(" ")).not.toMatch(
        /RAW TITLE|https?:\/\/|BODY|SUMMARY|PRIVATE_TAG/u,
      );
    },
  );

  it.each(["codex", "claude-code"] as const)(
    "replaces adversarial recovered-summary output with a fixed reply for %s",
    async (hostId) => {
      const state = defaultChannelState();
      const output = await handleInboundMessage({
        brain: fakeBrain(hostId),
        cwd: "/tmp",
        invokeBrain: async () =>
          recoveryOutcome(
            "RAW TITLE https://example.com BODY SUMMARY #PRIVATE_TAG",
            {
              enrichmentAction: "generate_summary",
              enrichmentCompleted: true,
              summaryStatus: "pending",
            },
          ),
        message: textMessage("处理一下摘要"),
        state,
      });

      expect(output.replies).toEqual(["摘要已补全。"]);
      expect(output.replies.join(" ")).not.toMatch(
        /RAW TITLE|https?:\/\/|BODY|SUMMARY|PRIVATE_TAG/u,
      );
      expect(state.history.at(-1)?.content).toBe("摘要已补全。");
    },
  );

  it("preserves normal non-enrichment conversation replies", async () => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => okOutcome("普通对话回答保持原样。"),
      message: textMessage("你能做什么？"),
      state,
    });

    expect(output.replies).toEqual(["普通对话回答保持原样。"]);
  });

  it.each([
    ["accepted", "generate_summary", true, "已收藏，摘要已补全。"],
    ["already_collected", "reuse_summary", false, "已在收藏中，已使用现有摘要。"],
    ["merged_with_existing_content", "none", false, "已收藏，已合并到已有内容。"],
  ] as const)(
    "treats an empty final model reply as success for %s %s",
    async (collectionStatus, enrichmentAction, enrichmentCompleted, expected) => {
      const state = defaultChannelState();
      const output = await handleInboundMessage({
        brain: fakeBrain("codex"),
        cwd: "/tmp",
        invokeBrain: async () =>
          controlledOutcome("", {
            collectionStatus,
            enrichmentAction,
            enrichmentCompleted,
          }),
        message: textMessage("https://example.com/raw"),
        state,
      });

      expect(output).toMatchObject({
        completed: true,
        processed: true,
        replies: [expected],
      });
      expect(state.history.at(-1)?.content).toBe(expected);
    },
  );

  it.each([
    ["invalid", "未保存：链接无效。"],
    ["unsafe", "未保存：链接未通过安全检查。"],
    ["resolution_pending", "链接仍在解析，收藏尚未完成。"],
    ["missing", "收藏结果无法确认，请稍后重试。"],
  ] as const)("preserves a content-free %s collection status", async (_status, expected) => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () =>
        ({
          ...okOutcome("RAW TITLE https://example.com BODY SUMMARY #TAG"),
          collectionReplyControl: { kind: "fixed", reply: expected },
        }) as BrainOutcome,
      message: textMessage("https://example.com/raw"),
      state,
    });

    expect(output.replies).toEqual([expected]);
    expect(output.replies.join(" ")).not.toMatch(/RAW TITLE|https?:\/\/|BODY|SUMMARY|TAG/u);
  });

  it("invokes the brain and records history plus session", async () => {
    const state = defaultChannelState();
    const invocations: Array<{ prompt: string; sessionId: string | null }> = [];
    const output = await handleInboundMessage({
      brain: fakeBrain("claude-code", "已收藏 ✓"),
      cwd: "/tmp",
      invokeBrain: async (input) => {
        invocations.push(input);
        return okOutcome("已收藏 ✓");
      },
      message: textMessage("https://example.com/a"),
      state,
    });
    expect(output.replies).toEqual(["已收藏 ✓"]);
    expect(state.ownerUserId).toBe("owner");
    expect(state.contextTokens.owner).toBe("ctx-1");
    expect(state.brainSession?.sessionId).toBe("session-1");
    expect(state.history).toEqual([
      { content: "https://example.com/a", role: "user" },
      { content: "已收藏 ✓", role: "assistant" },
    ]);
    expect(invocations[0]?.sessionId).toBeNull();
    expect(invocations[0]?.prompt).toContain("专用收藏渠道");
    expect(invocations[0]?.prompt).toContain("https://example.com/a");
  });

  it("deduplicates repeated message ids", async () => {
    const state = defaultChannelState();
    let calls = 0;
    const run = () =>
      handleInboundMessage({
        brain: fakeBrain("codex"),
        cwd: "/tmp",
        invokeBrain: async () => {
          calls += 1;
          return okOutcome("ok");
        },
        message: textMessage("same", { client_id: "fixed-id" }),
        state,
      });
    expect((await run()).processed).toBe(true);
    expect((await run()).processed).toBe(false);
    expect(calls).toBe(1);
  });

  it("uses a SHA-256 reference derived from the complete message id", async () => {
    const state = defaultChannelState();
    let prompt = "";
    await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async (input) => {
        prompt = input.prompt;
        return okOutcome("ok");
      },
      message: textMessage("hello", { client_id: "message-id-1" }),
      state,
    });

    expect(prompt).toContain(
      "msg-72cad190ed71ed0309138ac14e9982dbc21abd357ff0820d",
    );
    expect(prompt).not.toContain("msg-message-id-1");
  });

  it("handles exact status locally without invoking the brain", async () => {
    const state = defaultChannelState();
    state.runtimeState.phase = "degraded_runtime";
    let calls = 0;
    const output = await handleInboundMessage({
      brain: fakeBrain("codex", "never"),
      cwd: "/tmp",
      invokeBrain: async () => {
        calls += 1;
        return okOutcome("never");
      },
      message: textMessage(" 状态 "),
      state,
    });

    expect(calls).toBe(0);
    expect(output.completed).toBe(true);
    expect(output.replies.join("\n")).toContain("Codex");
    expect(output.replies.join("\n")).toContain("最近成功处理：无");
    expect(state.history).toEqual([]);
  });

  it("names the selected resident host in local status replies", async () => {
    const state = defaultChannelState();
    state.runtimeState.phase = "healthy";
    const output = await handleInboundMessage({
      brain: fakeBrain("claude-code"),
      cwd: "/tmp",
      message: textMessage("状态"),
      state,
    });

    expect(output.replies.join("\n")).toContain("Claude Code Runtime");
    expect(output.replies.join("\n")).not.toContain("Codex Runtime");
  });

  it("reports iLink, Runtime, Attention MCP, and Reporter independently", async () => {
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.runtimeState.phase = "healthy";
    state.attentionMcp.status = "auth_required";
    state.attentionMcp.lastErrorCode = "mcp_auth_required";
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      message: textMessage("状态"),
      state,
    });

    const reply = output.replies.join("\n");
    expect(reply).toContain("iLink：已登录");
    expect(reply).toContain("Codex Runtime：healthy");
    expect(reply).toContain(
      "Attention MCP：auth_required（微信对话仍可用）",
    );
    expect(reply).toContain("Reporter：未启用");
  });

  it("reports local summary retry counts and the nearest planned attempt", async () => {
    const state = defaultChannelState();
    state.summaryRetries = [
      {
        automaticAttempts: 1,
        collectionId: "11111111-1111-4111-8111-111111111111",
        cycleStartedAt: "2026-09-04T08:00:00.000Z",
        lastFailureClass: "enrichment_incomplete",
        nextAttemptAt: "2026-09-04T08:10:00.000Z",
        status: "scheduled",
      },
      {
        automaticAttempts: 3,
        collectionId: "22222222-2222-4222-8222-222222222222",
        cycleStartedAt: "2026-09-04T07:00:00.000Z",
        lastFailureClass: "enrichment_incomplete",
        nextAttemptAt: null,
        status: "paused",
      },
    ];
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      message: textMessage("状态"),
      state,
    });

    expect(output.replies.join("\n")).toContain(
      "摘要重试：1 项活动（0 项运行），1 项暂停；最近计划：2026-09-04T08:10:00.000Z",
    );
    expect(output.replies.join("\n")).not.toContain(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("defers retry completion until the recovery result is known", async () => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      message: textMessage("帮我重连一下？", { client_id: "retry-1" }),
      state,
    });

    expect(output).toMatchObject({
      completed: false,
      controlCommand: "retry",
      processed: true,
      replies: [],
    });
    expect(state.processedMessageIds).toEqual([]);
  });

  it("intercepts only the exact ephemeral Runtime pairing code", async () => {
    const state = defaultChannelState();
    let calls = 0;
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => {
        calls += 1;
        return okOutcome("never");
      },
      message: textMessage(" ABCD2345 "),
      pairingCode: "ABCD2345",
      state,
    });

    expect(calls).toBe(0);
    expect(output.controlCommand).toBe("pairing_verification");
    expect(output.replies).toEqual(["正在验证设备绑定…"]);
    expect(state.history).toEqual([]);
  });

  it("passes ordinary text containing command words to the brain", async () => {
    const state = defaultChannelState();
    state.runtimeState.phase = "degraded_runtime";
    state.runtimeState.activeTurnMessageRef = "msg-interrupted";
    let calls = 0;
    await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => {
        calls += 1;
        return okOutcome("ok");
      },
      message: textMessage("继续讨论这个方案"),
      state,
    });

    expect(calls).toBe(1);
  });

  it("pins the owner and ignores other senders", async () => {
    const state = defaultChannelState();
    state.ownerUserId = "owner";
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      message: {
        contextToken: "",
        fromUserId: "intruder",
        itemList: [{ text_item: { text: "hi" }, type: 1 }],
        raw: { from_user_id: "intruder" },
      },
      state,
    });
    expect(output.processed).toBe(false);
    expect(output.replies).toEqual([]);
  });

  it("answers non-text messages with the canned reply", async () => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex", "never"),
      cwd: "/tmp",
      invokeBrain: async () => okOutcome("never"),
      message: {
        contextToken: "ctx",
        fromUserId: "owner",
        itemList: [{ type: 2 }],
        raw: { from_user_id: "owner" },
      },
      state,
    });
    expect(output.replies).toEqual([NON_TEXT_REPLY]);
  });

  it("resets history and brain session on /reset", async () => {
    const state = defaultChannelState();
    state.history = [{ content: "old", role: "user" }];
    state.brainSession = {
      hostId: "claude-code",
      sessionId: "s",
      updatedAt: "now",
    };
    const output = await handleInboundMessage({
      brain: fakeBrain("claude-code", "x"),
      cwd: "/tmp",
      invokeBrain: async () => okOutcome("x"),
      message: textMessage("/reset"),
      state,
    });
    expect(output.replies).toEqual([RESET_REPLY]);
    expect(state.history).toEqual([]);
    expect(state.brainSession).toBeNull();
  });

  it("reasserts the no-confirm collection contract when continuing an existing host session", async () => {
    const state = defaultChannelState();
    state.brainSession = currentBrainSession("claude-code", "session-9");
    state.history = [
      { content: "q", role: "user" },
      { content: "a", role: "assistant" },
    ];
    const invocations: Array<{ prompt: string; sessionId: string | null }> = [];
    await handleInboundMessage({
      brain: fakeBrain("claude-code"),
      cwd: "/tmp",
      invokeBrain: async (input) => {
        invocations.push(input);
        return okOutcome("ok");
      },
      message: textMessage("选 1"),
      state,
    });
    expect(invocations[0]?.sessionId).toBe("session-9");
    expect(invocations[0]?.prompt).toContain("专用收藏渠道");
    expect(invocations[0]?.prompt).toContain("不要再要求确认");
    expect(invocations[0]?.prompt).not.toContain("对话历史");
    expect(invocations[0]?.prompt).toContain("选 1");
  });

  it("falls back to transcript replay when resume fails", async () => {
    const state = defaultChannelState();
    state.brainSession = currentBrainSession("claude-code", "stale");
    state.history = [
      { content: "q", role: "user" },
      { content: "a", role: "assistant" },
    ];
    const invocations: Array<{ prompt: string; sessionId: string | null }> = [];
    const output = await handleInboundMessage({
      brain: fakeBrain("claude-code"),
      cwd: "/tmp",
      invokeBrain: async (input) => {
        invocations.push(input);
        if (input.sessionId === "stale") {
          return {
            ok: false,
            reply: "",
            resumeFailed: true,
            sessionId: null,
            timedOut: false,
          };
        }
        return okOutcome("回来了", "session-10");
      },
      message: textMessage("还在吗"),
      state,
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.sessionId).toBeNull();
    expect(invocations[1]?.prompt).toContain("对话历史");
    expect(output.replies).toEqual(["回来了"]);
    expect(state.brainSession?.sessionId).toBe("session-10");
  });

  it("keeps the stored session when the host reports none", async () => {
    const state = defaultChannelState();
    state.brainSession = currentBrainSession("codex", "session-5");
    await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => ({
        ok: true,
        reply: "ok",
        resumeFailed: false,
        sessionId: null,
        timedOut: false,
      }),
      message: textMessage("hello"),
      state,
    });
    expect(state.brainSession?.sessionId).toBe("session-5");
  });

  it.each([
    ["legacy", undefined, undefined],
    [
      "old bridge version",
      "0.3.12",
      ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
    ],
    ["changed permission profile", ATTENTION_CLI_VERSION, "b".repeat(64)],
  ])(
    "rebuilds a %s session from preserved text history",
    async (_label, bridgeVersion, permissionProfileSha256) => {
      const state = defaultChannelState();
      state.brainSession = {
        ...(bridgeVersion ? { bridgeVersion } : {}),
        hostId: "codex",
        ...(permissionProfileSha256 ? { permissionProfileSha256 } : {}),
        sessionId: "stale-session",
        updatedAt: "2026-09-03T00:00:00.000Z",
      };
      state.history = [
        { content: "old question", role: "user" },
        { content: "old answer", role: "assistant" },
      ];
      const invocations: Array<{ prompt: string; sessionId: string | null }> = [];

      await handleInboundMessage({
        brain: fakeBrain("codex"),
        cwd: "/tmp",
        invokeBrain: async (input) => {
          invocations.push(input);
          return okOutcome("rebuilt", "fresh-session");
        },
        message: textMessage("continue"),
        state,
      });

      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.sessionId).toBeNull();
      expect(invocations[0]?.prompt).toContain("old question");
      expect(state.brainSession).toMatchObject({
        bridgeVersion: ATTENTION_CLI_VERSION,
        hostId: "codex",
        permissionProfileSha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
        sessionId: "fresh-session",
      });
    },
  );

  it("answers with a failure reply when the brain errors", async () => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => ({
        ok: false,
        reply: "",
        resumeFailed: false,
        sessionId: null,
        timedOut: false,
      }),
      message: textMessage("https://example.com"),
      state,
    });
    expect(output.replies).toEqual(["处理失败了，请稍后再试。"]);
    expect(output.completed).toBe(false);
    expect(state.processedMessageIds).toEqual([]);
    expect(state.history).toEqual([]);
  });

  it("answers with a timeout reply when the brain times out", async () => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => ({
        ok: false,
        reply: "",
        resumeFailed: false,
        sessionId: null,
        timedOut: true,
      }),
      message: textMessage("https://example.com"),
      state,
    });
    expect(output.replies).toEqual(["处理超时了，请稍后再试。"]);
    expect(output.completed).toBe(false);
    expect(state.processedMessageIds).toEqual([]);
  });

  it("keeps an MCP-dependent message pending when its tool call fails", async () => {
    const state = defaultChannelState();
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => ({
        attentionMcpFailure: {
          errorCode: "mcp_auth_required",
          retryable: false,
        },
        ok: true,
        reply: "模型误称操作成功",
        resumeFailed: false,
        sessionId: "session-1",
        timedOut: false,
      }),
      message: textMessage("收藏 https://example.com", {
        client_id: "collect-1",
      }),
      state,
    });

    expect(output.completed).toBe(false);
    expect(output.attentionMcpFailure).toEqual({
      errorCode: "mcp_auth_required",
      retryable: false,
    });
    expect(output.replies).toEqual([
      "Attention MCP 需要重新授权；这条操作已保留。请在电脑完成授权后发送“重试”。",
    ]);
    expect(state.runtimeState.activeTurnMessageRef).not.toBeNull();
    expect(state.processedMessageIds).toEqual([]);
    expect(state.history).toEqual([]);
  });

  it("still completes ordinary chat while Attention MCP needs authorization", async () => {
    const state = defaultChannelState();
    state.attentionMcp.status = "auth_required";
    const output = await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async () => okOutcome("我还在，可以继续聊。"),
      message: textMessage("你还在吗"),
      state,
    });

    expect(output.completed).toBe(true);
    expect(output.replies).toEqual(["我还在，可以继续聊。"]);
  });

  it("caps oversized input before it reaches the brain", async () => {
    const state = defaultChannelState();
    let seenPrompt = "";
    await handleInboundMessage({
      brain: fakeBrain("codex"),
      cwd: "/tmp",
      invokeBrain: async (input) => {
        seenPrompt = input.prompt;
        return okOutcome("ok");
      },
      message: textMessage("x".repeat(40_000)),
      state,
    });
    expect(seenPrompt.length).toBeLessThan(35_000);
    expect(seenPrompt).toContain("内容过长已截断");
  });
});

describe("buildMessageRef", () => {
  it("is stable and uses the complete id even for long shared prefixes", () => {
    expect(buildMessageRef("message-id-1")).toBe(
      "msg-72cad190ed71ed0309138ac14e9982dbc21abd357ff0820d",
    );
    const prefix = "a".repeat(100);
    expect(buildMessageRef(`${prefix}1`)).not.toBe(
      buildMessageRef(`${prefix}2`),
    );
    expect(buildMessageRef(`${prefix}1`)).toMatch(/^msg-[a-f0-9]{48}$/u);
  });
});

describe("matchControlCommand", () => {
  it.each([
    [" 状态 ", "status"],
    ["连接状态", "status"],
    ["/status", "status"],
    ["帮助", "help"],
    ["/help", "help"],
    ["重试", "retry"],
    ["重试一下", "retry"],
    ["再试一次", "retry"],
    ["重新连接", "retry"],
    ["重新连接一下", "retry"],
    ["重连", "retry"],
    ["帮我重连一下", "retry"],
    ["帮我重试一下", "retry"],
    ["帮我重连一下？", "retry"],
    ["　重试一下！　", "retry"],
    ["/retry", "retry"],
    ["继续", "continue"],
    ["/continue", "continue"],
    ["重置会话", "reset_confirmation"],
    ["/reset", "reset"],
  ] as const)("matches exact local command %s", (text, expected) => {
    expect(matchControlCommand(text, { degraded: true })).toBe(expected);
  });

  it.each([
    "继续讨论",
    "继续讨论这个方案",
    "帮我查看状态",
    "状态怎么样",
    "帮我重试这段代码",
    "重新连接数据库",
    "为什么重试还是失败",
    "写一个 retry 函数",
    "/status please",
  ])("does not intercept normal chat %s", (text) => {
    expect(matchControlCommand(text, { degraded: true })).toBeNull();
  });

  it("passes continue through while there is no resumable interruption", () => {
    expect(matchControlCommand("继续", { degraded: false })).toBeNull();
    expect(matchControlCommand("/continue", { degraded: false })).toBeNull();
  });
});

describe("splitReply", () => {
  it("keeps short replies intact", () => {
    expect(splitReply("短回复")).toEqual(["短回复"]);
  });

  it("splits long replies at sentence boundaries", () => {
    const sentence = "这是一个测试句子。";
    const long = sentence.repeat(600);
    const chunks = splitReply(long, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
    expect(chunks.join("")).toContain(sentence);
  });
});
