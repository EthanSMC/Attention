import type { SessionPrincipal } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import { createNativeWebsiteSession, WebsiteAgentError } from "@attention/website-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WebsiteAgentAdmissionError } from "./website-agent-budget";
import { WebsiteAgentSessionError } from "./website-agent-sessions";
import { WebsiteAgentUnavailableError } from "./website-agent-config";
import { handleWebsiteAgentRequest, type WebsiteAgentRequestDependencies } from "./website-agent-handler";

const accountId = "00000000-0000-4000-8000-000000000001";
const agentSessionId = "00000000-0000-4000-8000-000000000004";
const nativeSession = createNativeWebsiteSession(agentSessionId);
const storedSession = { id: agentSessionId, revision: 2, status: "open" as const, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", expiresAt: "2026-11-17T00:00:00.000Z", messages: [{ role: "user" as const, text: "find my saved article" }, {role: "assistant" as const, text: "A grounded answer"}], pending: null };
const operationId = "00000000-0000-4000-8000-000000000002";
const principal = { accountId, sessionId: "00000000-0000-4000-8000-000000000003", isMember: true, isFilter: false } as SessionPrincipal;
const request = (change: Record<string, unknown> = {}, headers: Record<string, string> = {}) => new Request("https://attention.example/api/website-agent/query", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ query: "find my saved article", session_id: agentSessionId, expected_revision: 0, operation_id: operationId, data_consent: true, ...change }),
});
function dependencies(audience: "allowlist" | "members" = "allowlist"): WebsiteAgentRequestDependencies {
  return {
    getDatabase: vi.fn(() => ({} as AttentionDatabase)),
    getSession: vi.fn(async () => ({ principal, shouldClearCookie: false })),
    getConfig: vi.fn(() => ({ audience, accountIds: audience === "allowlist" ? [accountId] : [], apiKey: "synthetic-key-never-returned", dailyCostMicrousd: null, maxRunCostMicrousd: 400_000 })),
    begin: vi.fn(async () => ({ accountId, sessionId: agentSessionId, runId: operationId, revision: 1, nativeSession })),
    finish: vi.fn(async () => storedSession), isActive: vi.fn(async () => true), createTools: vi.fn(() => []),
    run: vi.fn(async () => ({ answer: "A grounded answer", nativeSession, toolReceipts: [], usage: {
      modelCalls: 1, toolCalls: 0, inputTokens: 100, outputTokens: 10, observedCostMicrousd: 42, reservedCostMicrousd: 500,
    } })),
  };
}
afterEach(() => { vi.unstubAllEnvs(); });
function activateFingerprint() { vi.stubEnv("ATTENTION_HMAC_SECRET", "synthetic-hmac-secret-at-least-32-characters"); }

describe("website agent HTTP boundary", () => {
  it("reserves before generation and returns no credentials, history or raw tool data", async () => {
    activateFingerprint();
    const deps = dependencies();
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.begin).toHaveBeenCalledWith({}, expect.objectContaining({ accountId, operationId, dailyCostMicrousd: null }));
    expect(vi.mocked(deps.begin).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.run).mock.invocationCallOrder[0]!);
    expect(deps.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "find my saved article", apiKey: "synthetic-key-never-returned" }));
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("deepseek-flash");
    expect(serialized).not.toContain("synthetic-key");
    expect(serialized).not.toContain("accountId");
    expect(deps.finish).toHaveBeenCalledWith({}, expect.objectContaining({ accountId, sessionId: agentSessionId, runId: operationId, outcome: "completed", nativeSession, answer: "A grounded answer" }));
  });
  it.each([{ data_consent: false }, { accountId: "another-account" }, { messages: [] }, { model: "other-model" }, { query: "" }])("rejects absent consent or forged client-controlled context: %s", async change => {
      const deps = dependencies();
      expect((await handleWebsiteAgentRequest(request(change), deps)).status).toBe(400);
      expect(deps.begin).not.toHaveBeenCalled(); expect(deps.run).not.toHaveBeenCalled();
    });
  it("requires a current website session, Member and explicit rollout account", async () => {
    for (const [identity, status] of [[null, 401], [{ ...principal, isMember: false }, 403], [{ ...principal, accountId: operationId }, 403]] as const) {
      const deps = dependencies(); vi.mocked(deps.getSession).mockResolvedValue({ principal: identity, shouldClearCookie: false });
      expect((await handleWebsiteAgentRequest(request(), deps)).status).toBe(status);
      expect(deps.run).not.toHaveBeenCalled();
    }
  });
  it("supports separate authenticated Members without an allowlist and preserves the owner on every turn", async () => {
    activateFingerprint();
    for (const owner of [accountId, operationId]) {
      const deps = dependencies("members");
      vi.mocked(deps.getSession).mockResolvedValue({ principal: { ...principal, accountId: owner }, shouldClearCookie: false });
      vi.mocked(deps.begin).mockResolvedValue({ accountId: owner, sessionId: agentSessionId, runId: operationId, revision: 1, nativeSession });
      expect((await handleWebsiteAgentRequest(request(), deps)).status).toBe(200);
      expect(deps.begin).toHaveBeenCalledWith({}, expect.objectContaining({ accountId: owner }));
      expect(deps.createTools).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ accountId: owner, isMember: true }) }));
      expect(deps.finish).toHaveBeenCalledWith({}, expect.objectContaining({ accountId: owner, outcome: "completed" }));
    }
  });
  it.each([null, { ...principal, isMember: false }])("does not make members mode public or available to non-Members: %s", identity => {
    const deps = dependencies("members");
    vi.mocked(deps.getSession).mockResolvedValue({ principal: identity, shouldClearCookie: false });
    return handleWebsiteAgentRequest(request(), deps).then(response => {
      expect(response.status).toBe(identity ? 403 : 401);
      expect(deps.begin).not.toHaveBeenCalled(); expect(deps.run).not.toHaveBeenCalled();
    });
  });
  it.each(["model", "tool", "tool revalidate", "final"] as const)("rechecks members rollout before %s access and rejects a live narrowing to allowlist", async boundary => {
    activateFingerprint(); const deps = dependencies("members");
    const complete = vi.mocked(deps.run).getMockImplementation()!;
    vi.mocked(deps.run).mockImplementation(async options => {
      const toolsInput = vi.mocked(deps.createTools).mock.calls[0]![0];
      await options.beforeModelCall!(new AbortController().signal);
      expect(await toolsInput.getCurrentContext()).not.toBeNull();
      expect(await toolsInput.context.revalidate!()).not.toBeNull();
      const config = deps.getConfig();
      vi.mocked(deps.getConfig).mockReturnValue({ ...config, audience: "allowlist", accountIds: [operationId] });
      if (boundary === "final") return complete(options);
      if (boundary === "model") await expect(options.beforeModelCall!(new AbortController().signal)).rejects.toThrow("permission_revoked");
      if (boundary === "tool") expect(await toolsInput.getCurrentContext()).toBeNull();
      if (boundary === "tool revalidate") expect(await toolsInput.context.revalidate!()).toBeNull();
      throw new WebsiteAgentError("permission_revoked");
    });
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "permission_revoked" } });
    expect(deps.finish).not.toHaveBeenCalledWith({}, expect.objectContaining({ outcome: "completed" }));
  });
  it("rechecks membership while the members audience remains enabled", async () => {
    activateFingerprint(); const deps = dependencies("members");
    vi.mocked(deps.run).mockImplementation(async options => {
      vi.mocked(deps.getSession).mockResolvedValue({ principal: { ...principal, isMember: false }, shouldClearCookie: false });
      const toolsInput = vi.mocked(deps.createTools).mock.calls[0]![0];
      await expect(options.beforeModelCall!(new AbortController().signal)).rejects.toThrow("permission_revoked");
      expect(await toolsInput.getCurrentContext()).toBeNull();
      expect(await toolsInput.context.revalidate!()).toBeNull();
      throw new WebsiteAgentError("permission_revoked");
    });
    expect((await handleWebsiteAgentRequest(request(), deps)).status).toBe(502);
  });
  it("denies a guessed or foreign-owned agent session before any model call", async () => {
    activateFingerprint(); const deps = dependencies(); vi.mocked(deps.begin).mockRejectedValue(new WebsiteAgentSessionError("session_not_found"));
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(404); expect(deps.run).not.toHaveBeenCalled();
  });
  it("reconciles a failed native session save without claiming a completed answer", async () => {
    activateFingerprint(); const deps = dependencies(); vi.mocked(deps.finish).mockRejectedValueOnce(new Error("storage-down"));
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(503);
    expect(deps.finish).toHaveBeenLastCalledWith({}, expect.objectContaining({outcome: "failed"}));
  });
  it("rejects a revoked turn before tools or later model dispatch", async () => {
    activateFingerprint(); const deps = dependencies(); vi.mocked(deps.isActive).mockResolvedValue(false);
    vi.mocked(deps.run).mockImplementation(async options => {
      await expect(options.beforeModelCall!(new AbortController().signal)).rejects.toThrow("permission_revoked");
      throw new WebsiteAgentError("permission_revoked");
    });
    expect((await handleWebsiteAgentRequest(request(), deps)).status).toBe(502);
  });
  it("requires explicit runtime configuration and does not fall back to the legacy AI provider", async () => {
    const deps = dependencies(); vi.mocked(deps.getConfig).mockImplementation(() => { throw new WebsiteAgentUnavailableError("website_agent_disabled"); });
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(503); expect(deps.begin).not.toHaveBeenCalled(); expect(deps.run).not.toHaveBeenCalled();
  });
  it("rechecks live authorization after the final provider result before saving or returning it", async () => {
    activateFingerprint(); const deps = dependencies();
    const result = await deps.run({ apiKey: "synthetic-only", prompt: "fixture", tools: [], limits: { maxRunCostMicrousd: 1, maxModelCalls: 1, maxToolCalls: 0, maxOutputTokensPerCall: 1, maxContextBytes: 1, timeoutMs: 1 } });
    vi.mocked(deps.run).mockImplementation(async options => {
      await options.beforeModelCall!(new AbortController().signal);
      vi.mocked(deps.getSession).mockResolvedValue({ principal: null, shouldClearCookie: false });
      return result;
    });
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "permission_revoked" } });
    expect(deps.finish).not.toHaveBeenCalledWith({}, expect.objectContaining({ outcome: "completed" }));
    expect(deps.finish).toHaveBeenCalledWith({}, expect.objectContaining({ outcome: "failed" }));
  });
  it.each(["session", "membership", "rollout"] as const)("withholds a committed answer when %s access changes during persistence", async boundary => {
    activateFingerprint(); const deps = dependencies("members");
    vi.mocked(deps.finish).mockImplementation(async () => {
      if (boundary === "session") vi.mocked(deps.getSession).mockResolvedValue({ principal: null, shouldClearCookie: true });
      if (boundary === "membership") vi.mocked(deps.getSession).mockResolvedValue({ principal: { ...principal, isMember: false }, shouldClearCookie: false });
      if (boundary === "rollout") vi.mocked(deps.getConfig).mockReturnValue({ ...deps.getConfig(), audience: "allowlist", accountIds: [operationId] });
      return storedSession;
    });
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("permission_revoked");
    expect(body).not.toHaveProperty("answer");
    expect(body).not.toHaveProperty("session");
    expect(deps.finish).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({ outcome: "completed" }));
  });
  it("does not require the completed turn to remain active for the final authorization check", async () => {
    activateFingerprint(); const deps = dependencies();
    vi.mocked(deps.finish).mockImplementation(async () => {
      vi.mocked(deps.isActive).mockResolvedValue(false);
      return storedSession;
    });
    expect((await handleWebsiteAgentRequest(request(), deps)).status).toBe(200);
    expect(deps.finish).toHaveBeenCalledOnce();
  });
  it("fails closed before the provider on quota, duplicate or admission storage failure", async () => {
    activateFingerprint();
    for (const failure of [new WebsiteAgentAdmissionError("website_agent_daily_budget_exhausted"), new WebsiteAgentAdmissionError("operation_already_used"), new Error("storage-down")]) {
      const deps = dependencies(); vi.mocked(deps.begin).mockRejectedValue(failure);
      expect((await handleWebsiteAgentRequest(request(), deps)).status).toBeGreaterThanOrEqual(400);
      expect(deps.run).not.toHaveBeenCalled(); expect(deps.finish).not.toHaveBeenCalled();
    }
  });
  it("revalidates the same session before every model call", async () => {
    activateFingerprint();
    const deps = dependencies();
    vi.mocked(deps.run).mockImplementation(async options => {
      vi.mocked(deps.getSession).mockResolvedValue({ principal: { ...principal, sessionId: operationId }, shouldClearCookie: false });
      await expect(options.beforeModelCall!(new AbortController().signal)).rejects.toThrow("permission_revoked");
      throw new WebsiteAgentError("permission_revoked");
    });
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "permission_revoked" } });
    expect(deps.finish).toHaveBeenCalledWith({}, expect.objectContaining({ accountId, runId: operationId, outcome: "failed" }));
  });
  it("records cancellation without implying that already committed saves were undone", async () => {
    activateFingerprint(); const deps = dependencies(); vi.mocked(deps.run).mockRejectedValue(new WebsiteAgentError("cancelled"));
    const response = await handleWebsiteAgentRequest(request(), deps);
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { code: "cancelled", guidance: expect.stringContaining("not undone") } });
    expect(deps.finish).toHaveBeenCalledWith({}, expect.objectContaining({ accountId, runId: operationId, outcome: "cancelled" }));
  });
  it("rejects cross-origin and oversized requests without authentication or cost", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { "content-length": "20481" }]) {
      const deps = dependencies(); expect((await handleWebsiteAgentRequest(request({}, headers), deps)).status).toBeGreaterThanOrEqual(400);
      expect(deps.getSession).not.toHaveBeenCalled(); expect(deps.run).not.toHaveBeenCalled();
    }
  });
});
