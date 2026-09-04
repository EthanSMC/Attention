import { describe, expect, it } from "vitest";

import type {
  ClaudeStreamMessage,
  ClaudeStreamSnapshot,
} from "../claude-stream-rpc";
import {
  createClaudeResidentBrain,
  type ClaudeResidentRpc,
} from "./claude-resident";

class ScriptedClaudeRpc implements ClaudeResidentRpc {
  closeCount = 0;
  readonly sent: ClaudeStreamMessage[] = [];
  startCount = 0;
  #listener: ((message: ClaudeStreamMessage) => void) | null = null;
  #phase: ClaudeStreamSnapshot["phase"] = "idle";
  #pid: number | null = null;

  constructor(
    readonly requestedSessionId: string | null,
    readonly generatedSessionId: string,
  ) {}

  async start(): Promise<void> {
    this.startCount += 1;
    this.#phase = "running";
    this.#pid = 7_000 + this.startCount;
    queueMicrotask(() => {
      this.emit({
        session_id: this.requestedSessionId ?? this.generatedSessionId,
        subtype: "init",
        type: "system",
      });
    });
  }

  onMessage(listener: (message: ClaudeStreamMessage) => void): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = null;
    };
  }

  send(message: ClaudeStreamMessage): void {
    this.sent.push(message);
  }

  snapshot(): ClaudeStreamSnapshot {
    return {
      exitCode: null,
      lastErrorCode: null,
      phase: this.#phase,
      pid: this.#pid,
      signal: null,
      stderr: "",
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.#phase = "stopped";
    this.#pid = null;
  }

  emit(message: ClaudeStreamMessage): void {
    this.#listener?.(message);
  }

  complete(
    reply: string,
    options: { readonly isError?: boolean; readonly sessionId?: string } = {},
  ): void {
    const sessionId =
      options.sessionId ?? this.requestedSessionId ?? this.generatedSessionId;
    this.emit({
      message: {
        content: [{ text: reply, type: "text" }],
        role: "assistant",
      },
      session_id: sessionId,
      type: "assistant",
    });
    this.emit({
      is_error: options.isError ?? false,
      result: reply,
      session_id: sessionId,
      subtype: options.isError ? "error" : "success",
      type: "result",
    });
  }

  crash(): void {
    this.#phase = "stopped";
    this.#pid = null;
  }
}

function fixture() {
  const rpcs: ScriptedClaudeRpc[] = [];
  const brain = createClaudeResidentBrain({
    healthCheckIntervalMs: 5,
    mcpUrl: "https://attention.example/mcp",
    restartBackoffMs: [1],
    rpcFactory: ({ sessionId }) => {
      const rpc = new ScriptedClaudeRpc(sessionId, `session-${rpcs.length + 1}`);
      rpcs.push(rpc);
      return rpc;
    },
    runtimeDirectory: "/tmp/channel",
    turnTimeoutMs: 50,
  });
  return { brain, rpcs };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("resident Claude Code brain", () => {
  it("returns structured readiness after the matching account tool result", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "verify account",
      sessionId: null,
    });
    await nextTurn();
    const rpc = rpcs[0];
    rpc?.emit({
      message: {
        content: [
          {
            id: "account-1",
            input: {},
            name: "mcp__attention__attention_get_my_account",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      session_id: "session-1",
      type: "assistant",
    });
    rpc?.emit({
      message: {
        content: [
          {
            content: JSON.stringify({
              capabilities: { is_filter: true, is_member: true },
              profile: {
                attention_id: "ethan_01",
                display_name: "Ethan",
                has_avatar: true,
              },
            }),
            tool_use_id: "account-1",
            type: "tool_result",
          },
        ],
        role: "user",
      },
      session_id: "session-1",
      type: "user",
    });
    rpc?.complete("");

    await expect(pending).resolves.toMatchObject({
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
    });
    await brain.shutdown();
  });

  it("classifies an errored account result as MCP auth without degrading Claude auth", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "verify account",
      sessionId: null,
    });
    await nextTurn();
    const rpc = rpcs[0];
    rpc?.emit({
      message: {
        content: [
          {
            id: "account-auth-failure",
            input: {},
            name: "mcp__attention__attention_get_my_account",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      session_id: "session-1",
      type: "assistant",
    });
    rpc?.emit({
      message: {
        content: [
          {
            content: "OAuth authorization required",
            is_error: true,
            tool_use_id: "account-auth-failure",
            type: "tool_result",
          },
        ],
        role: "user",
      },
      session_id: "session-1",
      type: "user",
    });
    rpc?.complete("无法查询账号");

    await expect(pending).resolves.toMatchObject({
      attentionMcpFailure: {
        errorCode: "mcp_auth_required",
        retryable: false,
      },
      attentionMcpProbe: {
        errorCode: "mcp_auth_required",
        ok: false,
        retryable: false,
      },
    });
    expect(brain.runtimeSnapshot()).toMatchObject({
      lastErrorCode: null,
      phase: "healthy",
    });
    await brain.shutdown();
  });

  it("returns a content-free collection control from stream-json MCP results", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "collect",
      sessionId: null,
    });
    await nextTurn();
    const rpc = rpcs[0];
    rpc?.emit({
      message: {
        content: [
          {
            id: "select-1",
            input: {},
            name: "mcp__attention__attention_select_collection_candidate",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      session_id: "session-1",
      type: "assistant",
    });
    rpc?.emit({
      message: {
        content: [
          {
            content: JSON.stringify({
              collection_id: "11111111-1111-4111-8111-111111111111",
              enrichment_action: "reuse_summary",
              status: "accepted",
              title: "RAW TITLE",
              public_read_url: null,
            }),
            tool_use_id: "select-1",
            type: "tool_result",
          },
        ],
        role: "user",
      },
      session_id: "session-1",
      type: "user",
    });
    rpc?.complete("RAW TITLE https://example.com/raw BODY SUMMARY #TAG");

    await expect(pending).resolves.toMatchObject({
      collectionReplyControl: {
        collectionId: "11111111-1111-4111-8111-111111111111",
        collectionStatus: "accepted",
        enrichmentAction: "reuse_summary",
        enrichmentCompleted: false,
        kind: "established",
      },
    });
    await brain.shutdown();
  });

  it("automatically completes an eligible missing summary returned by status", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "处理一下摘要",
      sessionId: null,
    });
    await nextTurn();
    const rpc = rpcs[0];
    rpc?.emit({
      message: {
        content: [
          {
            id: "status-recovery-1",
            input: {},
            name: "mcp__attention__attention_get_collection_status",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      session_id: "session-1",
      type: "assistant",
    });
    rpc?.emit({
      message: {
        content: [
          {
            content: JSON.stringify({
              attempt: null,
              collection: {
                collection_id: "11111111-1111-4111-8111-111111111111",
              },
              content: {
                content_id: "content-1",
                enrichment_action: "generate_summary",
                public_read_url: "https://example.org/article",
                summary_status: "pending",
              },
            }),
            tool_use_id: "status-recovery-1",
            type: "tool_result",
          },
        ],
        role: "user",
      },
      session_id: "session-1",
      type: "user",
    });
    rpc?.emit({
      message: {
        content: [
          {
            id: "submit-recovery-1",
            input: {},
            name: "mcp__attention__attention_submit_content_enrichment",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      session_id: "session-1",
      type: "assistant",
    });
    rpc?.emit({
      message: {
        content: [
          {
            content: JSON.stringify({ status: "enriched", summary_status: "ready" }),
            tool_use_id: "submit-recovery-1",
            type: "tool_result",
          },
        ],
        role: "user",
      },
      session_id: "session-1",
      type: "user",
    });
    rpc?.complete("");

    await expect(pending).resolves.toMatchObject({
      collectionReplyControl: {
        collectionId: "11111111-1111-4111-8111-111111111111",
        enrichmentAction: "generate_summary",
        enrichmentCompleted: true,
        kind: "recovery",
        summaryStatus: "pending",
      },
      collectionReplySensitiveFragments: [
        "11111111-1111-4111-8111-111111111111",
        "content-1",
        "https://example.org/article",
      ],
      ok: true,
      reply: "",
    });
    await brain.shutdown();
  });

  it("returns a fixed content-free unsafe failure instead of model prose", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({ cwd: "/tmp/channel", prompt: "collect", sessionId: null });
    await nextTurn();
    const rpc = rpcs[0];
    rpc?.emit({
      message: { content: [{ id: "collect-unsafe", input: {}, name: "mcp__attention__attention_collect_content", type: "tool_use" }], role: "assistant" },
      session_id: "session-1", type: "assistant",
    });
    rpc?.emit({
      message: { content: [{ content: JSON.stringify({ status: "unsafe" }), tool_use_id: "collect-unsafe", type: "tool_result" }], role: "user" },
      session_id: "session-1", type: "user",
    });
    rpc?.complete("RAW TITLE https://example.com BODY");
    await expect(pending).resolves.toMatchObject({
      collectionReplyControl: { kind: "fixed", reply: "未保存：链接未通过安全检查。" },
    });
    await brain.shutdown();
  });

  it("fails closed when a collection tool has no result event", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({ cwd: "/tmp/channel", prompt: "collect", sessionId: null });
    await nextTurn();
    rpcs[0]?.emit({
      message: { content: [{ id: "collect-lost", input: {}, name: "mcp__attention__attention_collect_content", type: "tool_use" }], role: "assistant" },
      session_id: "session-1", type: "assistant",
    });
    rpcs[0]?.complete("RAW TITLE https://example.com BODY");
    await expect(pending).resolves.toMatchObject({
      collectionReplyControl: { kind: "fixed", reply: "收藏结果无法确认，请稍后重试。" },
    });
    await brain.shutdown();
  });

  it("ignores a parseable payload from an errored tool_result block", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({ cwd: "/tmp/channel", prompt: "collect", sessionId: null });
    await nextTurn();
    rpcs[0]?.emit({
      message: { content: [{ id: "select-error", input: {}, name: "mcp__attention__attention_select_collection_candidate", type: "tool_use" }], role: "assistant" },
      session_id: "session-1", type: "assistant",
    });
    rpcs[0]?.emit({
      message: { content: [{ content: JSON.stringify({ enrichment_action: "generate_summary", status: "accepted" }), is_error: true, tool_use_id: "select-error", type: "tool_result" }], role: "user" },
      session_id: "session-1", type: "user",
    });
    rpcs[0]?.complete("RAW TITLE https://example.com BODY SUMMARY #TAG");
    await expect(pending).resolves.toMatchObject({
      collectionReplyControl: { kind: "fixed", reply: "收藏结果无法确认，请稍后重试。" },
    });
    await brain.shutdown();
  });

  it("accepts an established selected result without final model text", async () => {
    const { brain, rpcs } = fixture();
    const pending = brain.invoke({ cwd: "/tmp/channel", prompt: "select", sessionId: null });
    await nextTurn();
    rpcs[0]?.emit({
      message: { content: [{ id: "select-empty", input: {}, name: "mcp__attention__attention_select_collection_candidate", type: "tool_use" }], role: "assistant" },
      session_id: "session-1", type: "assistant",
    });
    rpcs[0]?.emit({
      message: { content: [{ content: JSON.stringify({ collection_id: "11111111-1111-4111-8111-111111111111", enrichment_action: "none", status: "merged_with_existing_content" }), tool_use_id: "select-empty", type: "tool_result" }], role: "user" },
      session_id: "session-1", type: "user",
    });
    rpcs[0]?.complete("");
    await expect(pending).resolves.toMatchObject({
      ok: true,
      reply: "",
      collectionReplyControl: {
        collectionId: "11111111-1111-4111-8111-111111111111",
        collectionStatus: "merged_with_existing_content",
        enrichmentAction: "none",
        kind: "established",
      },
    });
    await brain.shutdown();
  });

  it("does not carry an unresolved timed-out collection tool into normal chat", async () => {
    const { brain, rpcs } = fixture();
    const timedOut = brain.invoke({ cwd: "/tmp/channel", prompt: "collect", sessionId: null });
    await nextTurn();
    rpcs[0]?.emit({
      message: { content: [{ id: "collect-timeout", input: {}, name: "mcp__attention__attention_collect_content", type: "tool_use" }], role: "assistant" },
      session_id: "session-1", type: "assistant",
    });
    await expect(timedOut).resolves.toMatchObject({ ok: false, timedOut: true });

    const normal = brain.invoke({ cwd: "/tmp/channel", prompt: "你好", sessionId: null });
    await nextTurn();
    rpcs.at(-1)?.complete("普通对话回答");
    await expect(normal).resolves.toMatchObject({
      ok: true,
      reply: "普通对话回答",
    });
    expect(await normal).not.toHaveProperty("collectionReplyControl");
    await brain.shutdown();
  });

  it("does not carry an unresolved crashed collection tool into normal chat", async () => {
    const { brain, rpcs } = fixture();
    await brain.start();
    const crashed = brain.invoke({ cwd: "/tmp/channel", prompt: "collect", sessionId: null });
    await nextTurn();
    rpcs[0]?.emit({
      message: { content: [{ id: "collect-crash", input: {}, name: "mcp__attention__attention_collect_content", type: "tool_use" }], role: "assistant" },
      session_id: "session-1", type: "assistant",
    });
    rpcs[0]?.crash();
    await expect(crashed).resolves.toMatchObject({ ok: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const normal = brain.invoke({ cwd: "/tmp/channel", prompt: "你好", sessionId: null });
    await nextTurn();
    rpcs.at(-1)?.complete("普通对话回答");
    await expect(normal).resolves.toMatchObject({ ok: true, reply: "普通对话回答" });
    expect(await normal).not.toHaveProperty("collectionReplyControl");
    await brain.shutdown();
  });

  it("reuses one stream-json process and one session for consecutive turns", async () => {
    const { brain, rpcs } = fixture();
    await brain.start();

    const firstPromise = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "one",
      sessionId: null,
    });
    await nextTurn();
    rpcs[0]?.complete("first reply");
    const first = await firstPromise;

    const secondPromise = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "two",
      sessionId: first.sessionId,
    });
    await nextTurn();
    rpcs[0]?.complete("second reply");
    const second = await secondPromise;

    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]?.startCount).toBe(1);
    expect(rpcs[0]?.sent).toEqual([
      {
        message: {
          content: [{ text: "one", type: "text" }],
          role: "user",
        },
        type: "user",
      },
      {
        message: {
          content: [{ text: "two", type: "text" }],
          role: "user",
        },
        type: "user",
      },
    ]);
    expect(first).toMatchObject({
      ok: true,
      reply: "first reply",
      sessionId: "session-1",
    });
    expect(second).toMatchObject({
      ok: true,
      reply: "second reply",
      sessionId: "session-1",
    });
    await brain.shutdown();
  });

  it("starts a fresh process after disposable preflight instead of leaking its session", async () => {
    const { brain, rpcs } = fixture();
    await brain.start();
    const preflightPromise = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "verify account",
      sessionId: null,
    });
    await nextTurn();
    rpcs[0]?.complete("verified");
    await preflightPromise;

    const firstRealTurn = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "save this",
      sessionId: null,
    });
    await nextTurn();
    expect(rpcs).toHaveLength(2);
    expect(rpcs[0]?.closeCount).toBe(1);
    rpcs[1]?.complete("saved");

    await expect(firstRealTurn).resolves.toMatchObject({
      ok: true,
      sessionId: "session-2",
    });
    await brain.shutdown();
  });

  it("resumes the stored session when the bridge process restarts", async () => {
    const { brain, rpcs } = fixture();
    const turn = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "continue",
      sessionId: "stored-session",
    });
    await nextTurn();

    expect(rpcs[0]?.requestedSessionId).toBe("stored-session");
    rpcs[0]?.complete("continued", { sessionId: "stored-session" });
    await expect(turn).resolves.toMatchObject({
      ok: true,
      sessionId: "stored-session",
    });
    await brain.shutdown();
  });

  it("restarts a crashed process with the latest Claude session", async () => {
    const { brain, rpcs } = fixture();
    await brain.start();

    const firstTurn = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "remember this",
      sessionId: null,
    });
    await nextTurn();
    rpcs[0]?.complete("remembered", { sessionId: "resident-session" });
    await expect(firstTurn).resolves.toMatchObject({
      ok: true,
      sessionId: "resident-session",
    });

    rpcs[0]?.crash();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(rpcs).toHaveLength(2);
    expect(rpcs[1]?.requestedSessionId).toBe("resident-session");
    expect(brain.runtimeSnapshot()).toMatchObject({
      lastErrorCode: null,
      phase: "healthy",
    });
    await brain.shutdown();
  });

  it("marks an unavailable resume so the shared pipeline can replay 20 turns", async () => {
    const { brain, rpcs } = fixture();
    const turn = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "continue",
      sessionId: "missing-session",
    });
    await nextTurn();
    rpcs[0]?.complete("No conversation found with session ID", {
      isError: true,
      sessionId: "missing-session",
    });

    await expect(turn).resolves.toMatchObject({
      ok: false,
      resumeFailed: true,
      sessionId: "missing-session",
    });
    expect(brain.runtimeSnapshot()).toMatchObject({
      lastErrorCode: "claude_session_missing",
      phase: "replaying_history",
    });
    await brain.shutdown();
  });

  it("does not report an errored result with partial text as success", async () => {
    const { brain, rpcs } = fixture();
    const turn = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "save",
      sessionId: null,
    });
    await nextTurn();
    rpcs[0]?.complete("MCP unavailable", { isError: true });

    await expect(turn).resolves.toMatchObject({
      ok: false,
      reply: "",
      resumeFailed: false,
    });
    await brain.shutdown();
  });

  it("times out one turn without resolving queued work as success", async () => {
    const { brain, rpcs } = fixture();
    const first = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "slow",
      sessionId: null,
    });
    const second = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "queued",
      sessionId: null,
    });

    await expect(first).resolves.toMatchObject({ ok: false, timedOut: true });
    await nextTurn();
    expect(rpcs).toHaveLength(2);
    rpcs[1]?.complete("queued reply");
    await expect(second).resolves.toMatchObject({
      ok: true,
      reply: "queued reply",
    });
    await brain.shutdown();
  });

  it("supports shutdown then start and rejects work queued in the old lifecycle", async () => {
    const { brain, rpcs } = fixture();
    await brain.start();
    const active = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "active",
      sessionId: null,
    });
    const queued = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "queued",
      sessionId: null,
    });
    await nextTurn();
    await brain.shutdown();

    await expect(active).resolves.toMatchObject({ ok: false });
    await expect(queued).resolves.toMatchObject({ ok: false });
    expect(brain.runtimeSnapshot().phase).toBe("stopped");

    await brain.start();
    const fresh = brain.invoke({
      cwd: "/tmp/channel",
      prompt: "fresh",
      sessionId: null,
    });
    await nextTurn();
    rpcs.at(-1)?.complete("fresh reply");
    await expect(fresh).resolves.toMatchObject({
      ok: true,
      reply: "fresh reply",
    });
    await brain.shutdown();
  });
});
