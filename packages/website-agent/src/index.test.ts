import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type SimpleStreamOptions, type ToolCall } from "@earendil-works/pi-ai";

import { createNativeWebsiteSession, parseNativeWebsiteSession, appendInterruptedNativeWebsiteSession, websiteAgentSessionMessages, assertNativeWebsiteSessionContinuation, runWebsiteAgent, DEEPSEEK_FLASH_MODEL, WebsiteAgentError, type NativeWebsiteAgentSession, type RunWebsiteAgentOptions, type WebsiteAgentLimits, type WebsiteAgentTool } from "./index.js";

const limits: WebsiteAgentLimits = {
  maxRunCostMicrousd: 100_000,
  maxModelCalls: 4,
  maxToolCalls: 4,
  maxOutputTokensPerCall: 100,
  maxContextBytes: 50_000,
  timeoutMs: 5000,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-completions", provider: "deepseek", model: "deepseek-flash",
    timestamp: 1, stopReason,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.000003, output: 0.000006, cacheRead: 0, cacheWrite: 0, total: 0.000009 } },
  };
}
function text(value = "Done.") { return assistant([{ type: "text", text: value }]); }
function call(id = "call_1", name = "search", args: unknown = { query: "Attention" }): ToolCall {
  return { type: "toolCall", id, name, arguments: args as Record<string, unknown> };
}
function nativeStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "length" ? "length" : "stop", message });
  }
  return stream;
}
function scripted(messages: AssistantMessage[], inspect?: (context: Context, options?: SimpleStreamOptions) => void): StreamFn {
  let index = 0;
  return vi.fn((_model, context, options) => {
    inspect?.(context, options);
    const message = messages[index++];
    if (!message) throw new Error("Unexpected model call");
    return nativeStream(structuredClone(message));
  });
}
function tool(invoke: WebsiteAgentTool["invoke"] = async (args) => ({ matches: [args] })): WebsiteAgentTool {
  return {
    name: "search", description: "Search Attention's stored items.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
    invoke,
  };
}
function run(overrides: Partial<RunWebsiteAgentOptions> = {}) {
  return runWebsiteAgent({ prompt: "Find Attention notes", apiKey: "offline-test-key", tools: [tool()], limits, streamFn: scripted([text()]), ...overrides });
}
afterEach(() => vi.unstubAllGlobals());

describe("native Pi website agent", () => {
  it("uses the exact model, bounded options, and returns only public final text", async () => {
    const streamFn: StreamFn = vi.fn((model, context, options) => {
      expect(model).toEqual(DEEPSEEK_FLASH_MODEL);
      expect(model.id).toBe("deepseek-flash");
      expect(model.baseUrl).toBe("https://api.deepseek.com");
      expect(options).toMatchObject({ maxTokens: 100, maxRetries: 0, cacheRetention: "none" });
      expect(options?.reasoning).toBeUndefined();
      expect(context.messages).toHaveLength(1);
      expect(context.messages[0]?.role).toBe("user");
      return nativeStream(assistant([{ type: "thinking", thinking: "private scratch reasoning" }, { type: "text", text: "Visible answer" }]));
    });
    const result = await run({ streamFn });
    expect(result.answer).toBe("Visible answer");
    expect(JSON.stringify(result)).not.toMatch(/scratch|offline-test-key|systemPrompt/);
    expect(result.usage).toMatchObject({ modelCalls: 1, inputTokens: 10, outputTokens: 5, observedCostMicrousd: 9 });
    expect(result.usage.reservedCostMicrousd).toBeGreaterThan(9);
  });

  it("executes explicitly registered tools sequentially in the real Agent loop", async () => {
    const order: string[] = [];
    const contexts: Context[] = [];
    const invoke = vi.fn(async (_args: unknown, { toolCallId, signal }: { toolCallId: string; signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false);
      order.push(`start:${toolCallId}`);
      await Promise.resolve();
      order.push(`end:${toolCallId}`);
      return { ok: toolCallId };
    });
    const result = await run({ tools: [tool(invoke)], streamFn: scripted([
      assistant([call("a"), call("b")], "toolUse"), text("Found both."),
    ], (context) => contexts.push(structuredClone(JSON.parse(JSON.stringify(context)) as Context))) });
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(contexts[1]?.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
    expect(result.usage).toMatchObject({ modelCalls: 2, toolCalls: 2 });
    expect(result.toolReceipts).toEqual([
      { toolCallId: "a", toolName: "search", status: "completed" },
      { toolCallId: "b", toolName: "search", status: "completed" },
    ]);
  });

  it("uses native DeepSeek provider streaming and sends thinking disabled without a live request", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response([
        'data: {"id":"fake","object":"chat.completion.chunk","model":"deepseek-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"Native provider answer"},"finish_reason":null}]}\n\n',
        'data: {"id":"fake","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWebsiteAgent({ prompt: "Hello", apiKey: "offline-test-key", tools: [], limits });
    expect(result.answer).toBe("Native provider answer");
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({ model: "deepseek-flash", max_tokens: 100, thinking: { type: "disabled" }, parallel_tool_calls: false });
    expect(requestBodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("never calls unregistered tools or starts a mixed batch containing one", async () => {
    const invoke = vi.fn();
    await expect(run({ tools: [tool(invoke)], streamFn: scripted([assistant([call(), call("bad", "shell")], "toolUse")]) })).rejects.toMatchObject({ code: "unknown_tool" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([{ query: 42 }, { query: "ok", dangerous: true }, {}, null, "not an object"])("rejects raw malformed input without coercion: %j", async (args) => {
    const invoke = vi.fn();
    await expect(run({ tools: [tool(invoke)], streamFn: scripted([assistant([call("bad", "search", args)], "toolUse")]) })).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects repeated tool-call IDs without replaying a completed effect", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    await expect(run({ tools: [tool(invoke)], streamFn: scripted([
      assistant([call("same")], "toolUse"), assistant([call("same")], "toolUse"),
    ]) })).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("bounds tool input bytes before invoking the adapter", async () => {
    const invoke = vi.fn();
    await expect(run({ tools: [tool(invoke)], limits: { ...limits, maxToolInputBytes: 10 }, streamFn: scripted([assistant([call()], "toolUse")]) })).rejects.toMatchObject({ code: "tool_input_limit" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("bounds tool output and preserves the completed effect receipt", async () => {
    await expect(run({ tools: [tool(async () => ({ result: "x".repeat(100) }))], limits: { ...limits, maxToolOutputBytes: 10 }, streamFn: scripted([assistant([call()], "toolUse")]) })).rejects.toMatchObject({
      code: "tool_output_limit", toolReceipts: [{ toolCallId: "call_1", status: "completed" }],
    });
  });

  it("sanitizes tool errors and does not continue the model loop", async () => {
    const streamFn = scripted([assistant([call()], "toolUse")]);
    const error = await run({ tools: [tool(async () => { throw new Error("secret DB host / credential"); })], streamFn }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WebsiteAgentError);
    expect(error).toMatchObject({ code: "tool_error" });
    expect(String(error)).not.toContain("secret");
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("fails an over-budget batch before any tools run", async () => {
    const invoke = vi.fn();
    await expect(run({ tools: [tool(invoke)], limits: { ...limits, maxToolCalls: 1 }, streamFn: scripted([assistant([call("a"), call("b")], "toolUse")]) })).rejects.toMatchObject({ code: "tool_limit" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("caps model turns with no extra provider request", async () => {
    const streamFn = scripted([assistant([call()], "toolUse")]);
    await expect(run({ limits: { ...limits, maxModelCalls: 1 }, streamFn })).rejects.toMatchObject({ code: "model_limit", usage: { modelCalls: 1, toolCalls: 1 } });
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit cost ceiling and rejects the first call before spending", async () => {
    const streamFn = scripted([text()]);
    await expect(run({ limits: { ...limits, maxRunCostMicrousd: 1 }, streamFn })).rejects.toMatchObject({ code: "budget_exceeded", usage: { modelCalls: 0, reservedCostMicrousd: 0 } });
    expect(streamFn).not.toHaveBeenCalled();
    const { maxRunCostMicrousd: _unused, ...missingCost } = limits;
    await expect(run({ limits: missingCost as WebsiteAgentLimits })).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("reserves all calls cumulatively rather than refunding provider-reported cheap usage", async () => {
    const first = await run();
    const streamFn = scripted([assistant([call()], "toolUse")]);
    await expect(run({ streamFn, limits: { ...limits, maxRunCostMicrousd: first.usage.reservedCostMicrousd + 10 } })).rejects.toMatchObject({ code: "budget_exceeded", usage: { modelCalls: 1 } });
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("preflights the full schema/system context, not only the user prompt", async () => {
    const streamFn = scripted([text()]);
    await expect(run({ prompt: "Hi", limits: { ...limits, maxContextBytes: 100 }, streamFn })).rejects.toMatchObject({ code: "context_limit" });
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("checks the actual expanded provider payload before network submission", async () => {
    const streamFn: StreamFn = async (_model, _context, options) => {
      await options?.onPayload?.({ messages: [{ content: "x".repeat(20_000) }] }, DEEPSEEK_FLASH_MODEL);
      return nativeStream(text());
    };
    await expect(run({ streamFn, limits: { ...limits, maxRunCostMicrousd: 2000 } })).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  it("handles provider stream errors and unexpected throws without leaking provider details", async () => {
    const message = { ...text(), stopReason: "error" as const, errorMessage: "secret provider error" };
    await expect(run({ streamFn: scripted([message]) })).rejects.toMatchObject({ code: "provider_error" });
    await expect(run({ streamFn: () => { throw new Error("private key detail"); } })).rejects.toMatchObject({ code: "provider_error" });
  });

  it("does not execute truncated tool requests", async () => {
    const invoke = vi.fn();
    await expect(run({ tools: [tool(invoke)], streamFn: scripted([assistant([call()], "length")]) })).rejects.toMatchObject({ code: "output_limit" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects missing public answers and oversized answers", async () => {
    await expect(run({ streamFn: scripted([assistant([{ type: "thinking", thinking: "not an answer" }])]) })).rejects.toMatchObject({ code: "empty_answer" });
    await expect(run({ streamFn: scripted([text("x".repeat(100))]), limits: { ...limits, maxAnswerBytes: 10 } })).rejects.toMatchObject({ code: "output_limit" });
  });

  it("does not replay unexpected reasoning on the next native loop turn", async () => {
    const seen: Context[] = [];
    await run({ streamFn: scripted([assistant([{ type: "thinking", thinking: "hidden" }, call()], "toolUse"), text()], (context) => seen.push(context)) });
    const prior = seen[1]?.messages.find((message) => message.role === "assistant");
    expect(prior?.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "thinking" })]));
  });

  it("cancels before starting and propagates in-flight cancellation to tools", async () => {
    const before = new AbortController(); before.abort();
    const streamFn = scripted([text()]);
    await expect(run({ signal: before.signal, streamFn })).rejects.toMatchObject({ code: "cancelled" });
    expect(streamFn).not.toHaveBeenCalled();
    const during = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const invoke: WebsiteAgentTool["invoke"] = async (_args, { signal }) => {
      observedSignal = signal;
      during.abort();
      return new Promise(() => {});
    };
    await expect(run({ signal: during.signal, tools: [tool(invoke)], streamFn: scripted([assistant([call()], "toolUse")]) })).rejects.toMatchObject({ code: "cancelled", toolReceipts: [{ status: "unknown" }] });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("bounds stalled provider streams with a timeout and cancels their signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const streamFn: StreamFn = (_model, _context, options) => { observedSignal = options?.signal; return createAssistantMessageEventStream(); };
    await expect(run({ streamFn, limits: { ...limits, timeoutMs: 20 } })).rejects.toMatchObject({ code: "timeout", usage: { modelCalls: 1 } });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("starts with fresh backend-owned context on every request", async () => {
    const contexts: Context[] = [];
    for (const prompt of ["First", "Second"]) {
      await run({ prompt, streamFn: scripted([text()], (context) => contexts.push(context)) });
    }
    expect(contexts[1]?.messages).toHaveLength(1);
    expect(contexts[1]?.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "Second" }] });
  });

  it("revalidates live permission before every model dispatch and stops on revocation", async () => {
    const streamFn = scripted([assistant([call()], "toolUse"), text()]);
    const beforeModelCall = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("membership revoked"));
    await expect(run({ streamFn, beforeModelCall })).rejects.toMatchObject({ code: "permission_revoked", usage: { modelCalls: 1 } });
    expect(beforeModelCall).toHaveBeenCalledTimes(2);
    expect(streamFn).toHaveBeenCalledTimes(1);
    const noCall = scripted([text()]);
    await expect(run({ streamFn: noCall, beforeModelCall: async () => { throw new Error("revoked"); } })).rejects.toMatchObject({ code: "permission_revoked" });
    expect(noCall).not.toHaveBeenCalled();
  });

  it("validates tool registrations and rejects duplicates", async () => {
    await expect(run({ tools: [tool(), tool()] })).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(run({ prompt: " " })).rejects.toMatchObject({ code: "invalid_input" });
  });
});


const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
function nativeHistory(pairs = 1, id = SESSION_A): NativeWebsiteAgentSession {
  let session = createNativeWebsiteSession(id);
  for (let i = 0; i < pairs; i++) session = appendInterruptedNativeWebsiteSession(session, `Question ${i}`, `Answer ${i}`);
  return session;
}
function longNativeHistory(size = 3000): NativeWebsiteAgentSession {
  let session = createNativeWebsiteSession(SESSION_A);
  for (let i = 0; i < 5; i++) session = appendInterruptedNativeWebsiteSession(session, `Question ${i}: ${"x".repeat(size)}`, `Answer ${i}: ${"y".repeat(size)}`);
  return session;
}
function isSummary(context: Context): boolean { return context.systemPrompt?.includes("context summarization assistant") === true; }

describe("native Pi session management", () => {
  it("creates/exports native v3 entries and strictly binds the native ID", () => {
    const session = createNativeWebsiteSession(SESSION_A);
    expect(session.entries[0]).toMatchObject({ type: "session", version: 3, id: SESSION_A, cwd: "/attention/website-agent" });
    expect(session.leafId).toBeNull();
    expect(parseNativeWebsiteSession(session, SESSION_A)).toEqual(session);
    expect(() => parseNativeWebsiteSession(session, SESSION_B)).toThrowError(WebsiteAgentError);
  });

  it("resumes a persisted native session through SessionManager and the real AgentSession", async () => {
    const prior = nativeHistory();
    const streamFn = scripted([text("Continued")], context => {
      expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
      expect(context.messages[0]?.content).toEqual([{ type: "text", text: "Question 0" }]);
    });
    const result = await run({ nativeSession: prior, prompt: "Continue", streamFn });
    expect(websiteAgentSessionMessages(result.nativeSession).map(message => message.text)).toEqual(["Question 0", "Answer 0", "Continue", "Continued"]);
    expect(result.nativeSession.entries.slice(0, prior.entries.length)).toEqual(prior.entries);
    expect(() => assertNativeWebsiteSessionContinuation(prior, result.nativeSession, "Continue", "Continued")).not.toThrow();
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("respects the selected native branch without replaying a different branch", async () => {
    const prior = nativeHistory();
    const archived = appendInterruptedNativeWebsiteSession(prior, "OTHER_BRANCH_PROMPT", "OTHER_BRANCH_ANSWER");
    archived.leafId = prior.leafId;
    const branched = appendInterruptedNativeWebsiteSession(archived, "SELECTED_BRANCH_PROMPT", "SELECTED_BRANCH_ANSWER");
    expect(branched.entries.length).toBeGreaterThan(archived.entries.length);
    expect(websiteAgentSessionMessages(branched).some(message => message.text.includes("OTHER_BRANCH"))).toBe(false);
    const result = await run({ nativeSession: branched, streamFn: scripted([text()], context => {
      expect(JSON.stringify(context.messages)).toContain("SELECTED_BRANCH_ANSWER");
      expect(JSON.stringify(context.messages)).not.toContain("OTHER_BRANCH");
    }) });
    expect(result.nativeSession.entries.slice(0, branched.entries.length)).toEqual(branched.entries);
    expect(() => assertNativeWebsiteSessionContinuation(branched, result.nativeSession, "Find Attention notes", "Done.")).not.toThrow();
  });

  it("redacts native reasoning/tool result entries but hydrates raw source evidence only for the current run", async () => {
    const streamFn = scripted([
      assistant([{ type: "thinking", thinking: "PRIVATE_THOUGHT" }, call()], "toolUse"), text("Source summary"),
    ], context => {
      if (context.messages.some(message => message.role === "toolResult")) expect(JSON.stringify(context)).toContain("RAW_SOURCE_SECRET_BODY");
    });
    const result = await run({ nativeSession: createNativeWebsiteSession(SESSION_A), tools: [tool(async () => ({ body: "RAW_SOURCE_SECRET_BODY" }))], streamFn });
    expect(JSON.stringify(result.nativeSession)).not.toMatch(/PRIVATE_THOUGHT|RAW_SOURCE_SECRET_BODY/);
    expect(result.nativeSession.entries.some(entry => entry.type === "message" && entry.message.role === "toolResult")).toBe(true);
    await run({ nativeSession: result.nativeSession, streamFn: scripted([text()], context => {
      expect(JSON.stringify(context)).not.toMatch(/RAW_SOURCE_SECRET_BODY|PRIVATE_THOUGHT/);
    }) });
  });

  it("keeps copied source text in tool arguments and intermediate prose transient", async () => {
    const invoke = vi.fn(async () => ({ body: "RAW_COPIED_SOURCE_BODY" }));
    const streamFn = scripted([
      assistant([call("first")], "toolUse"),
      assistant([{ type: "text", text: "RAW_COPIED_SOURCE_BODY" }, call("second", "search", { query: "RAW_COPIED_SOURCE_BODY" })], "toolUse"),
      text("Public summary with https://example.com/source"),
    ], context => {
      const second = context.messages.find(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === "second"));
      if (second) expect(JSON.stringify(second)).toContain("RAW_COPIED_SOURCE_BODY");
    });
    const result = await run({ nativeSession: createNativeWebsiteSession(SESSION_A), tools: [tool(invoke)], streamFn });
    expect(invoke).toHaveBeenNthCalledWith(2, { query: "RAW_COPIED_SOURCE_BODY" }, expect.objectContaining({ toolCallId: "second" }));
    expect(JSON.stringify(result.nativeSession)).not.toContain("RAW_COPIED_SOURCE_BODY");
    expect(JSON.stringify(result.nativeSession)).toContain("https://example.com/source");
    const calls = result.nativeSession.entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.filter(part => part.type === "toolCall") : []);
    expect(calls.map(call => call.arguments)).toEqual([{}, {}]);
    expect(websiteAgentSessionMessages(result.nativeSession)).toEqual([
      { role: "user", text: "Find Attention notes" }, { role: "assistant", text: "Public summary with https://example.com/source" },
    ]);
  });

  it("does not replay historical tool IDs or restore removed capabilities", async () => {
    const prior = await run({ nativeSession: createNativeWebsiteSession(SESSION_A), streamFn: scripted([assistant([call()], "toolUse"), text()]) });
    const invoke = vi.fn();
    await expect(run({ nativeSession: prior.nativeSession, tools: [tool(invoke)], streamFn: scripted([assistant([call()], "toolUse")]) })).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    await expect(run({ nativeSession: prior.nativeSession, tools: [], streamFn: scripted([assistant([call("fresh_id")], "toolUse")]) })).rejects.toMatchObject({ code: "unknown_tool" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["system", "thinking", "custom", "bashExecution"])("rejects unauthorized native message roles: %s", async role => {
    const session = nativeHistory();
    const message = session.entries[1];
    if (message?.type === "message") Object.assign(message.message, { role });
    const streamFn = scripted([text()]);
    await expect(run({ nativeSession: session, streamFn })).rejects.toMatchObject({ code: "invalid_session" });
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("rejects invalid native graphs, unsupported entries, and raw tool storage", () => {
    const base = nativeHistory();
    const invalidGraph = structuredClone(base);
    Object.assign(invalidGraph.entries[1]!, { parentId: invalidGraph.entries[1]!.id });
    expect(() => parseNativeWebsiteSession(invalidGraph, SESSION_A)).toThrow();
    const invalidEntry = structuredClone(base);
    Object.assign(invalidEntry.entries[1]!, { type: "custom" });
    expect(() => parseNativeWebsiteSession(invalidEntry, SESSION_A)).toThrow();
    const rawTool = structuredClone(base);
    Object.assign(rawTool.entries[1]!, { message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE RAW BODY" }], timestamp: 1, toolCallId: "a", toolName: "read", isError: false, details: {} } });
    expect(() => parseNativeWebsiteSession(rawTool, SESSION_A)).toThrow();
  });

  it.each([
    { usage: { ...text().usage, credential: "SECRET" } },
    { usage: { ...text().usage, cost: { ...text().usage.cost, secret: "SECRET" } } },
    { errorMessage: "SECRET" },
    { content: [call("raw", "search", { query: "RAW_SOURCE" })], stopReason: "toolUse" },
  ])("rejects unexpected durable assistant metadata: %j", patch => {
    const session = nativeHistory();
    const entry = session.entries[2];
    if (entry?.type === "message") Object.assign(entry.message, patch);
    expect(() => parseNativeWebsiteSession(session, SESSION_A)).toThrow();
  });

  it("fails closed at the native storage cap without trimming old native entries", async () => {
    const prior = nativeHistory();
    const entry = prior.entries[1];
    if (entry?.type === "message" && entry.message.role === "user") entry.message.content = [{ type: "text", text: "x".repeat(500_000) }];
    const original = structuredClone(prior);
    const streamFn = scripted([text()]);
    await expect(run({ nativeSession: prior, streamFn, limits: { ...limits, maxContextBytes: 900_000 } })).rejects.toMatchObject({ code: "session_full" });
    expect(streamFn).not.toHaveBeenCalled();
    expect(prior).toEqual(original);
  });

  it("uses native compaction and records its dispatch under the same call and cost budget", async () => {
    let prior = createNativeWebsiteSession(SESSION_A);
    for (let i = 0; i < 5; i++) prior = appendInterruptedNativeWebsiteSession(prior, `Question ${i}: ${"x".repeat(1500)}`, `Answer ${i}: ${"y".repeat(1500)}`);
    const streamFn = scripted([text("Native compacted summary"), text("Latest answer")]);
    const result = await run({ nativeSession: prior, compact: true, streamFn });
    expect(result.nativeSession.entries.some(entry => entry.type === "compaction")).toBe(true);
    expect(result.usage.modelCalls).toBe(2);
    expect(result.usage.inputTokens).toBe(20);
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(result.nativeSession.entries.slice(0, prior.entries.length)).toEqual(prior.entries);
    expect(() => assertNativeWebsiteSessionContinuation(prior, result.nativeSession, "Find Attention notes", "Latest answer")).not.toThrow();
  });

  it("cannot spend outside the budget for native compaction", async () => {
    const prior = longNativeHistory();
    const streamFn = scripted([text("summary")]);
    await expect(run({ nativeSession: prior, compact: true, streamFn, limits: { ...limits, maxRunCostMicrousd: 1 } })).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("compacts at the application soft bound, budgets both split-turn calls, and reloads the native checkpoint", async () => {
    const prior = longNativeHistory();
    const summaries: Context[] = [];
    const streamFn: StreamFn = vi.fn((_model, context) => {
      if (isSummary(context)) {
        summaries.push(structuredClone(context));
        return nativeStream(text(`Native checkpoint ${summaries.length}`));
      }
      return nativeStream(text("Latest answer"));
    });
    const beforeModelCall = vi.fn(async () => {});
    const result = await run({ nativeSession: prior, streamFn, beforeModelCall });
    expect(summaries).toHaveLength(2);
    expect(result.usage).toMatchObject({ modelCalls: 3, inputTokens: 30, outputTokens: 15 });
    expect(beforeModelCall).toHaveBeenCalledTimes(3);
    expect(result.nativeSession.entries.slice(0, prior.entries.length)).toEqual(prior.entries);
    expect(() => assertNativeWebsiteSessionContinuation(prior, result.nativeSession, "Find Attention notes", "Latest answer")).not.toThrow();
    const history = websiteAgentSessionMessages(result.nativeSession);
    expect(history).toHaveLength(12);
    expect(history[0]?.text).toBe(websiteAgentSessionMessages(prior)[0]?.text);
    expect(history.some(message => message.text.includes("Native checkpoint"))).toBe(false);
    await run({ nativeSession: JSON.parse(JSON.stringify(result.nativeSession)) as NativeWebsiteAgentSession, streamFn: scripted([text("Resumed")], context => {
      expect(JSON.stringify(context.messages)).toContain("Native checkpoint 1");
      expect(JSON.stringify(context.messages)).toContain("Native checkpoint 2");
      expect(JSON.stringify(context.messages)).not.toContain("Question 0:");
    }) });
  });

  it("bounds a split-turn's second summary dispatch and never retries a failed summary", async () => {
    const streamFn = scripted([text("First checkpoint")]);
    await expect(run({ nativeSession: longNativeHistory(), compact: true, streamFn, limits: { ...limits, maxModelCalls: 1 } })).rejects.toMatchObject({ code: "model_limit", usage: { modelCalls: 1 } });
    expect(streamFn).toHaveBeenCalledTimes(1);
    const failed = scripted([{ ...text(), stopReason: "error", errorMessage: "503 service temporarily unavailable SECRET" }]);
    await expect(run({ nativeSession: longNativeHistory(), compact: true, streamFn: failed })).rejects.toMatchObject({ code: "provider_error", usage: { modelCalls: 1 } });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("rechecks permission for the second split summary and charges its reservation cumulatively", async () => {
    const prior = longNativeHistory();
    const denied = scripted([text("First checkpoint")]);
    const beforeModelCall = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    await expect(run({ nativeSession: prior, compact: true, streamFn: denied, beforeModelCall })).rejects.toMatchObject({ code: "permission_revoked", usage: { modelCalls: 1 } });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(beforeModelCall).toHaveBeenCalledTimes(2);
    let firstReservation = 0;
    await run({ nativeSession: prior, compact: true, streamFn: (_model, context) => {
      if (!firstReservation) {
        const inputCeiling = new TextEncoder().encode(JSON.stringify(context)).byteLength + 1024 + 128 * (context.messages.length + (context.tools?.length ?? 0));
        firstReservation = Math.ceil((inputCeiling * 3 + limits.maxOutputTokensPerCall * 12) / 10);
      }
      return nativeStream(text(isSummary(context) ? "Checkpoint" : "Done"));
    } });
    const bounded = scripted([text("First checkpoint")]);
    await expect(run({ nativeSession: prior, compact: true, streamFn: bounded, limits: { ...limits, maxRunCostMicrousd: firstReservation } })).rejects.toMatchObject({ code: "budget_exceeded", usage: { modelCalls: 1, reservedCostMicrousd: firstReservation } });
    expect(bounded).toHaveBeenCalledTimes(1);
  });

  it("bounds compaction output and cancels stalled native compaction without publishing a checkpoint", async () => {
    const prior = longNativeHistory();
    const original = structuredClone(prior);
    await expect(run({ nativeSession: prior, compact: true, streamFn: scripted([text("x".repeat(200))]), limits: { ...limits, maxAnswerBytes: 10 } })).rejects.toMatchObject({ code: "output_limit" });
    const abort = new AbortController();
    let signal: AbortSignal | undefined;
    const streamFn: StreamFn = (_model, _context, options) => {
      signal = options?.signal;
      queueMicrotask(() => abort.abort());
      return createAssistantMessageEventStream();
    };
    await expect(run({ nativeSession: prior, compact: true, streamFn, signal: abort.signal })).rejects.toMatchObject({ code: "cancelled", usage: { modelCalls: 1 } });
    expect(signal?.aborted).toBe(true);
    expect(prior).toEqual(original);
  });

  it("requires renewed permission for native summary dispatches", async () => {
    let prior = createNativeWebsiteSession(SESSION_A);
    for (let i = 0; i < 3; i++) prior = appendInterruptedNativeWebsiteSession(prior, "x".repeat(4000), "y".repeat(4000));
    const streamFn = scripted([text()]);
    await expect(run({ nativeSession: prior, compact: true, streamFn, beforeModelCall: async () => { throw new Error("revoked"); } })).rejects.toMatchObject({ code: "permission_revoked" });
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("rejects forged continuation prefixes and mismatched completed answers", () => {
    const prior = nativeHistory();
    const next = appendInterruptedNativeWebsiteSession(prior, "New question", "Interrupted; effects may have completed.");
    expect(() => assertNativeWebsiteSessionContinuation(prior, next, "New question", "Interrupted; effects may have completed.")).not.toThrow();
    expect(() => assertNativeWebsiteSessionContinuation(prior, next, "Other query")).toThrow();
    expect(() => assertNativeWebsiteSessionContinuation(prior, next, "New question", "Invented success")).toThrow();
    const forged = structuredClone(next);
    const entry = forged.entries[1];
    if (entry?.type === "message" && entry.message.role === "user") entry.message.content = [{ type: "text", text: "Rewritten history" }];
    expect(() => assertNativeWebsiteSessionContinuation(prior, forged, "New question")).toThrow();
  });

  it("keeps concurrent native sessions isolated and capabilities fresh", async () => {
    const a = appendInterruptedNativeWebsiteSession(createNativeWebsiteSession(SESSION_A), "ACCOUNT_A_MARKER", "Earlier shell access");
    const b = appendInterruptedNativeWebsiteSession(createNativeWebsiteSession(SESSION_B), "ACCOUNT_B_MARKER", "Earlier shell access");
    const results = await Promise.all([a, b].map((nativeSession, index) => run({ nativeSession, tools: [], streamFn: scripted([text()], context => {
      expect(context.tools).toEqual([]);
      expect(JSON.stringify(context)).not.toContain(index === 0 ? "ACCOUNT_B_MARKER" : "ACCOUNT_A_MARKER");
    }) })));
    expect(results[0]?.nativeSession.entries[0]?.id).toBe(SESSION_A);
    expect(results[1]?.nativeSession.entries[0]?.id).toBe(SESSION_B);
  });
});
