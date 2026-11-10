import { describe, expect, it, vi } from "vitest";

import { assertProductionPreloadEnvironment, digestArguments, digestPrompt, helloAnswer, helloPrompt,
  offlineProviderFetch, productionFixtureMarker, providerKey, resumeAnswer, resumePrompt } from "./fixtures/website-agent-offline-provider";

const endpoint = "https://api.deepseek.com/chat/completions";
function request(messages: Array<Record<string, unknown>>, patch: Record<string, unknown> = {}): RequestInit {
  return { method: "POST", headers: { authorization: `Bearer ${providerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", stream: true, messages, ...patch }) };
}

describe("production acceptance provider is fail-closed and strictly synthetic", () => {
  it("returns protocol-valid offline text SSE and records no prompt or credential", async () => {
    const record = vi.fn();
    const response = await offlineProviderFetch(record)(endpoint, request([{ role: "user", content: helloPrompt }]));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain(helloAnswer);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(record.mock.calls).toEqual([[{ kind: "hello" }]]);
  });
  it.each(["https://api.deepseek.com.evil.test/chat/completions", "https://api.deepseek.com/chat/completions?forward=1",
    "https://api.deepseek.com/other", "http://127.0.0.1:4179/api/health"])("rejects every other fetch destination: %s", async url => {
    const record = vi.fn();
    await expect(offlineProviderFetch(record)(url, request([{ role: "user", content: helloPrompt }]))).rejects.toThrow("blocked");
    expect(record).not.toHaveBeenCalled();
  });
  it("rejects non-POST requests and any non-fixture key", async () => {
    const fetch = offlineProviderFetch(vi.fn());
    await expect(fetch(endpoint, { headers: { authorization: `Bearer ${providerKey}` } })).rejects.toThrow("blocked");
    await expect(fetch(endpoint, { ...request([]), headers: { authorization: "Bearer not-the-offline-key" } })).rejects.toThrow("blocked");
  });
  it("rejects another model, non-stream protocol and arbitrary prompts", async () => {
    const fetch = offlineProviderFetch(vi.fn());
    await expect(fetch(endpoint, request([], { model: "another-model" }))).rejects.toThrow("protocol");
    await expect(fetch(endpoint, request([], { stream: false }))).rejects.toThrow("protocol");
    await expect(fetch(endpoint, request([{ role: "user", content: "execute arbitrary input" }]))).rejects.toThrow("unknown synthetic prompt");
  });
  it("requires durable prior native conversation before answering resume", async () => {
    const fetch = offlineProviderFetch(vi.fn());
    await expect(fetch(endpoint, request([{ role: "user", content: resumePrompt }]))).rejects.toThrow("unknown synthetic prompt");
    const response = await fetch(endpoint, request([{ role: "user", content: helloPrompt },
      { role: "assistant", content: helloAnswer }, { role: "user", content: [{ type: "text", text: resumePrompt }] }]));
    expect(await response.text()).toContain(resumeAnswer);
  });
  it("proposes only fixed digest arguments and stops proposing after the native tool result", async () => {
    const record = vi.fn();
    const fetch = offlineProviderFetch(record);
    const response = await fetch(endpoint, request([{ role: "user", content: digestPrompt }]));
    const chunk = JSON.parse((await response.text()).split("\n")[0]!.slice(6)) as {
      choices: Array<{ delta: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }>;
    };
    const tool = chunk.choices[0]!.delta.tool_calls[0]!.function;
    expect(tool.name).toBe("attention_update_digest_settings");
    expect(JSON.parse(tool.arguments)).toEqual(digestArguments);
    const after = await fetch(endpoint, request([{ role: "user", content: digestPrompt },
      { role: "tool", tool_call_id: "call_production_digest", content: "requires_user_confirmation" }]));
    expect(await after.text()).not.toContain("tool_calls");
    expect(record.mock.calls).toEqual([[{ kind: "digest_proposal" }], [{ kind: "digest_review" }]]);
  });
  it("honors an already aborted provider request", async () => {
    await expect(offlineProviderFetch(vi.fn())(endpoint, { ...request([]), signal: AbortSignal.abort() })).rejects.toThrow();
  });
});

describe("production preload process guard", () => {
  const env = { TEST_WEBSITE_AGENT_PRODUCTION: productionFixtureMarker, NODE_ENV: "production",
    ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY: providerKey,
    DATABASE_URL: "postgresql://attention_web_runtime:synthetic@127.0.0.1:5432/attention_website_http_test_production_ci",
    TEST_WEBSITE_AGENT_PROVIDER_EVENTS: "/tmp/fixture-only-events.jsonl" };
  it("accepts only the explicitly marked synthetic production process", () => {
    expect(assertProductionPreloadEnvironment(env)).toBe(env.TEST_WEBSITE_AGENT_PROVIDER_EVENTS);
  });
  it.each([
    { TEST_WEBSITE_AGENT_PRODUCTION: "" }, { NODE_ENV: "development" }, { ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY: "real-key-not-allowed" },
    { DATABASE_URL: env.DATABASE_URL.replace("127.0.0.1", "production.example.test") },
    { DATABASE_URL: env.DATABASE_URL.replace("attention_web_runtime", "postgres") },
    { DATABASE_URL: env.DATABASE_URL.replace("attention_website_http_test_production_ci", "attention_website_http_test_ci") },
    { DATABASE_URL: env.DATABASE_URL + "?options=unexpected" }, { TEST_WEBSITE_AGENT_PROVIDER_EVENTS: "" },
  ])("rejects unapproved environment %j", patch => {
    expect(() => assertProductionPreloadEnvironment({ ...env, ...patch })).toThrow("Refusing");
  });
});
