import { describe, expect, it } from "vitest";
import { safeCollectionReply } from "./collection-reply-control";
import { handleInboundMessage, matchControlCommand } from "./pipeline";
import { defaultChannelState } from "./state";
import { initialReaderBudget } from "./reader-recovery";
import type { BrainAdapter, BrainOutcome } from "./brain";

const collectionId = "11111111-1111-4111-8111-111111111111";
const control = { collectionId, kind: "recovery", enrichmentAction: "generate_summary", enrichmentCompleted: false, summaryStatus: "pending" } as const;
const securityRead = { collectionId, attemptRef: "read-1", outcome: "failed", methods: ["static"], failureCode: "unsafe_source", failureScope: "security", recovery: "stop", retryAfterMs: null } as const;
const brain: BrainAdapter = {
  hostId: "codex", start: async () => {}, shutdown: async () => {},
  invoke: async () => { throw new Error("use test invoke"); },
  runtimeSnapshot: () => ({ phase: "healthy", lastErrorCode: null, retryAttempt: 0 }),
};

describe("contextual conversation recovery", () => {
  it.each(["重试", "重试一下", "再试一次", "帮我重试一下"])("passes %s to the Agent even when transport is degraded", text => {
    expect(matchControlCommand(text, { degraded: false })).toBeNull();
    expect(matchControlCommand(text, { degraded: true })).toBeNull();
  });
  it.each(["/retry", "重新连接", "帮我重连一下"])("retains explicit transport command %s", text => {
    expect(matchControlCommand(text, { degraded: false })).toBe("retry");
  });
  it("keeps a terminal read terminal on a status-only follow-up without resetting its budget", async () => {
    const state = defaultChannelState();
    state.ownerUserId = "owner";
    state.summaryRetries.push({ collectionId, automaticAttempts: 0, cycleStartedAt: "2026-09-10T13:00:00.000Z", lastFailureClass: null, nextAttemptAt: null, status: "paused", reader: { schemaVersion: 1, category: "content", budget: initialReaderBudget(), lastRead: securityRead } });
    const before = JSON.stringify(state.summaryRetries);
    const outcome: BrainOutcome = { ok: true, reply: "", resumeFailed: false, sessionId: "session", timedOut: false, collectionReplyControl: control };
    const result = await handleInboundMessage({ brain, cwd: "/tmp", state,
      message: { fromUserId: "owner", contextToken: "ctx", itemList: [{ type: 1, text_item: { text: "为什么停止了呢" } }], raw: { message_id: "question-1" } },
      invokeBrain: async () => outcome,
    });
    expect(JSON.stringify(state.summaryRetries)).toBe(before);
    expect(result.replies.join("")).toContain("安全");
    expect(result.replies.join("")).not.toContain("再让我重试");
    expect(result.replies.join("")).not.toContain("这轮自动重试仍");
  });
  it.each([
    "读取被安全规则拦截，摘要还没生成。继续尝试也不会解决，需要先排查拦截原因。",
    "来源要求验证，暂时没有拿到正文。需要完成验证后才能继续。",
  ])("retains truthful AI explanations without requiring fixed wording: %s", reply => {
    expect(safeCollectionReply(control, reply, { phase: "paused", nextAttemptAt: null, sensitiveFragments: [] })).toMatchObject({ accepted: true, text: reply });
  });
  it("does not misreport a security stop as exhausted retries or invite a blind retry", () => {
    for (const reply of ["自动重试次数已用完，现已停止。", "读取被拦截，已停止；你可以随时让我重试。"])
      expect(safeCollectionReply(control, reply, { phase: "paused", readRecovery: "stop", readFailureCode: "unsafe_source", nextAttemptAt: null, sensitiveFragments: [] })).toMatchObject({ accepted: false, text: expect.stringContaining("安全检查") });
  });
  it("explains a required verification without promising MCP reconnection can solve it", () => {
    const result = safeCollectionReply(control, "", { phase: "paused", readRecovery: "needs_action", readFailureCode: "verification_required", nextAttemptAt: null, sensitiveFragments: [] });
    expect(result.text).toContain("来源要求验证");
    expect(result.text).not.toContain("再让我重试");
  });
});
