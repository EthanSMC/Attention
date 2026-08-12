import { describe, expect, it } from "vitest";

import type { BrainAdapter, BrainOutcome } from "./brain";
import { NON_TEXT_REPLY, RESET_REPLY } from "./limits";
import {
  buildMessageRef,
  handleInboundMessage,
  matchControlCommand,
  splitReply,
} from "./pipeline";
import { defaultChannelState } from "./state";

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
      kind: "established",
      ...control,
    },
  }) as BrainOutcome;

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
      expect(output.replies.join(" ")).not.toMatch(
        /RAW TITLE|https?:\/\/|BODY SENTINEL|SUMMARY SENTINEL|TAG_SENTINEL/u,
      );
      expect(state.history.at(-1)?.content).toBe("已收藏，摘要已补全。");
    },
  );

  it.each([
    ["codex", "generate_summary", true, "已收藏，摘要已补全。"],
    ["codex", "generate_summary", false, "已收藏，摘要待补全。"],
    ["codex", "reuse_summary", false, "已收藏，已使用现有摘要。"],
    ["claude-code", "generate_summary", true, "已收藏，摘要已补全。"],
    ["claude-code", "generate_summary", false, "已收藏，摘要待补全。"],
    ["claude-code", "reuse_summary", false, "已收藏，已使用现有摘要。"],
  ] as const)(
    "uses a fixed safe selected-result acknowledgment for %s %s completed=%s",
    async (hostId, enrichmentAction, enrichmentCompleted, expected) => {
      const state = defaultChannelState();
      state.history = [
        { content: "share with two links", role: "user" },
        { content: "请选择 1 或 2", role: "assistant" },
      ];
      state.brainSession = {
        hostId,
        sessionId: "selected-session",
        updatedAt: "now",
      };
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
    state.brainSession = {
      hostId: "claude-code",
      sessionId: "session-9",
      updatedAt: "now",
    };
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
    state.brainSession = {
      hostId: "claude-code",
      sessionId: "stale",
      updatedAt: "now",
    };
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
    state.brainSession = {
      hostId: "codex",
      sessionId: "session-5",
      updatedAt: "now",
    };
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
    ["重新连接", "retry"],
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
