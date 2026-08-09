import { describe, expect, it } from "vitest";

import type { BrainOutcome } from "./brain";
import { NON_TEXT_REPLY, RESET_REPLY } from "./limits";
import { handleInboundMessage, splitReply } from "./pipeline";
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

describe("handleInboundMessage", () => {
  it("invokes the brain and records history plus session", async () => {
    const state = defaultChannelState();
    const invocations: Array<{ prompt: string; sessionId: string | null }> = [];
    const output = await handleInboundMessage({
      brain: { hostId: "claude-code", invoke: async () => okOutcome("已收藏 ✓") },
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
        brain: { hostId: "codex", invoke: async () => okOutcome("ok") },
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

  it("pins the owner and ignores other senders", async () => {
    const state = defaultChannelState();
    state.ownerUserId = "owner";
    const output = await handleInboundMessage({
      brain: { hostId: "codex", invoke: async () => okOutcome("ok") },
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
      brain: { hostId: "codex", invoke: async () => okOutcome("never") },
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
      brain: { hostId: "claude-code", invoke: async () => okOutcome("x") },
      cwd: "/tmp",
      invokeBrain: async () => okOutcome("x"),
      message: textMessage("/reset"),
      state,
    });
    expect(output.replies).toEqual([RESET_REPLY]);
    expect(state.history).toEqual([]);
    expect(state.brainSession).toBeNull();
  });

  it("continues an existing host session without replaying intent", async () => {
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
      brain: { hostId: "claude-code", invoke: async () => okOutcome("ok") },
      cwd: "/tmp",
      invokeBrain: async (input) => {
        invocations.push(input);
        return okOutcome("ok");
      },
      message: textMessage("选 1"),
      state,
    });
    expect(invocations[0]?.sessionId).toBe("session-9");
    expect(invocations[0]?.prompt).not.toContain("专用收藏渠道");
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
      brain: { hostId: "claude-code", invoke: async () => okOutcome("ok") },
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
      brain: { hostId: "codex", invoke: async () => okOutcome("ok") },
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
      brain: { hostId: "codex", invoke: async () => okOutcome("ok") },
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
      brain: { hostId: "codex", invoke: async () => okOutcome("ok") },
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
      brain: { hostId: "codex", invoke: async () => okOutcome("ok") },
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
