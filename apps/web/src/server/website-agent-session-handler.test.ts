import type { SessionPrincipal } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it, vi } from "vitest";

import { handleWebsiteAgentSessionRequest, type WebsiteAgentSessionRequestDependencies } from "./website-agent-session-handler";
import { WebsiteAgentSessionError } from "./website-agent-sessions";
import { WebsiteAgentUnavailableError } from "./website-agent-config";

const accountId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const principal = { accountId, sessionId, isMember: true, isFilter: false } as SessionPrincipal;
const view = { id: sessionId, revision: 1, status: "open" as const, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", expiresAt: "2026-11-17T00:00:00.000Z", messages: [], pending: null };
function dependencies(audience: "allowlist" | "members" = "allowlist"): WebsiteAgentSessionRequestDependencies {
  return {
    getDatabase: vi.fn(() => ({} as AttentionDatabase)), getSession: vi.fn(async () => ({ principal, shouldClearCookie: false })),
    getConfig: vi.fn(() => ({ audience, accountIds: audience === "allowlist" ? [accountId] : [], apiKey: "synthetic-only", dailyCostMicrousd: null, maxRunCostMicrousd: 400_000 })),
    create: vi.fn(async () => view), list: vi.fn(async () => [view]), load: vi.fn(async () => view), close: vi.fn(async () => ({ ...view, status: "closed" as const })),
  };
}
const request = (method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request("https://attention.example/api/website-agent/sessions", {
  method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("tenant-owned website session HTTP surface", () => {
  it.each(["allowlist", "members"] as const)("uses only the authenticated account for create/list/load/close with %s audience", async audience => {
    const deps = dependencies(audience);
    expect((await handleWebsiteAgentSessionRequest(request("POST", {}), "create", undefined, deps)).status).toBe(201);
    expect(deps.create).toHaveBeenCalledWith({}, accountId);
    const listed = await handleWebsiteAgentSessionRequest(request(), "list", undefined, deps);
    expect(listed.headers.get("cache-control")).toBe("no-store"); expect(deps.list).toHaveBeenCalledWith({}, accountId);
    expect((await handleWebsiteAgentSessionRequest(request(), "load", sessionId, deps)).status).toBe(200);
    expect(deps.load).toHaveBeenCalledWith({}, accountId, sessionId);
    expect((await handleWebsiteAgentSessionRequest(request("POST", { expected_revision: 1 }), "close", sessionId, deps)).status).toBe(200);
    expect(deps.close).toHaveBeenCalledWith({}, { accountId, sessionId, expectedRevision: 1 });
  });
  it("routes a second Member's sessions exclusively through that account", async () => {
    const deps = dependencies("members");
    vi.mocked(deps.getSession).mockResolvedValue({ principal: { ...principal, accountId: sessionId }, shouldClearCookie: false });
    expect((await handleWebsiteAgentSessionRequest(request("POST", {}), "create", undefined, deps)).status).toBe(201);
    expect(deps.create).toHaveBeenCalledWith({}, sessionId);
    expect((await handleWebsiteAgentSessionRequest(request(), "list", undefined, deps)).status).toBe(200);
    expect(deps.list).toHaveBeenCalledWith({}, sessionId);
    vi.mocked(deps.load).mockRejectedValue(new WebsiteAgentSessionError("session_not_found"));
    expect((await handleWebsiteAgentSessionRequest(request(), "load", accountId, deps)).status).toBe(404);
    expect(deps.load).toHaveBeenCalledWith({}, sessionId, accountId);
    vi.mocked(deps.close).mockRejectedValue(new WebsiteAgentSessionError("session_not_found"));
    expect((await handleWebsiteAgentSessionRequest(request("POST", { expected_revision: 1 }), "close", accountId, deps)).status).toBe(404);
    expect(deps.close).toHaveBeenCalledWith({}, { accountId: sessionId, sessionId: accountId, expectedRevision: 1 });
  });
  it.each(["list", "create", "load", "close"] as const)("denies unauthenticated and non-Member %s access even with members audience", async operation => {
    for (const identity of [null, { ...principal, isMember: false }]) {
      const deps = dependencies("members");
      vi.mocked(deps.getSession).mockResolvedValue({ principal: identity, shouldClearCookie: false });
      const req = operation === "create" || operation === "close" ? request("POST", operation === "close" ? { expected_revision: 1 } : {}) : request();
      expect((await handleWebsiteAgentSessionRequest(req, operation, sessionId, deps)).status).toBe(identity ? 403 : 401);
      expect(deps[operation]).not.toHaveBeenCalled();
    }
  });
  it.each(["list", "create", "load", "close"] as const)("checks rollout and activation before %s storage access", async operation => {
    for (const disabled of [false, true]) {
      const deps = dependencies();
      if (disabled) vi.mocked(deps.getConfig).mockImplementation(() => { throw new WebsiteAgentUnavailableError("website_agent_disabled"); });
      else vi.mocked(deps.getSession).mockResolvedValue({ principal: { ...principal, accountId: sessionId }, shouldClearCookie: false });
      const req = operation === "create" || operation === "close" ? request("POST", operation === "close" ? { expected_revision: 1 } : {}) : request();
      expect((await handleWebsiteAgentSessionRequest(req, operation, sessionId, deps)).status).toBe(disabled ? 503 : 403);
      expect(deps[operation]).not.toHaveBeenCalled();
    }
  });
  it.each(["list", "create", "load", "close"] as const)("withholds %s results if rollout narrows while storage is pending", async operation => {
    const deps = dependencies("members");
    const revoke = () => {
      const config = deps.getConfig();
      vi.mocked(deps.getConfig).mockReturnValue({ ...config, audience: "allowlist", accountIds: [sessionId] });
    };
    vi.mocked(deps.list).mockImplementation(async () => { revoke(); return [view]; });
    vi.mocked(deps.create).mockImplementation(async () => { revoke(); return view; });
    vi.mocked(deps.load).mockImplementation(async () => { revoke(); return view; });
    vi.mocked(deps.close).mockImplementation(async () => { revoke(); return { ...view, status: "closed" }; });
    const req = operation === "create" || operation === "close" ? request("POST", operation === "close" ? { expected_revision: 1 } : {}) : request();
    const response = await handleWebsiteAgentSessionRequest(req, operation, sessionId, deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "website_agent_not_enabled_for_account" } });
  });
  it.each(["create", "close"] as const)("rechecks membership after parsing before %s writes", async operation => {
    const deps = dependencies("members");
    vi.mocked(deps.getSession).mockResolvedValue({ principal: { ...principal, isMember: false }, shouldClearCookie: false })
      .mockResolvedValueOnce({ principal, shouldClearCookie: false });
    expect((await handleWebsiteAgentSessionRequest(request("POST", operation === "close" ? { expected_revision: 1 } : {}), operation, sessionId, deps)).status).toBe(403);
    expect(deps[operation]).not.toHaveBeenCalled();
  });
  it.each([null, { ...principal, accountId: sessionId }, { ...principal, sessionId: accountId }])("withholds conversation data when authentication changes while loading: %s", identity => {
    const deps = dependencies("members");
    vi.mocked(deps.load).mockImplementation(async () => {
      vi.mocked(deps.getSession).mockResolvedValue({ principal: identity, shouldClearCookie: false });
      return view;
    });
    return handleWebsiteAgentSessionRequest(request(), "load", sessionId, deps).then(async response => {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "authentication_required" } });
    });
  });
  it("fails closed when disabled while loading a session", async () => {
    const deps = dependencies("members");
    vi.mocked(deps.load).mockImplementation(async () => {
      vi.mocked(deps.getConfig).mockImplementation(() => { throw new WebsiteAgentUnavailableError("website_agent_disabled"); });
      return view;
    });
    const response = await handleWebsiteAgentSessionRequest(request(), "load", sessionId, deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "website_agent_disabled" } });
  });
  it("does not treat personal-agent OAuth/MCP credentials as a browser session", async () => {
    const deps = dependencies(); vi.mocked(deps.getSession).mockResolvedValue({ principal: null, shouldClearCookie: false });
    expect((await handleWebsiteAgentSessionRequest(request("GET", undefined, { authorization: "Bearer synthetic-mcp-token" }), "list", undefined, deps)).status).toBe(401);
    expect(deps.list).not.toHaveBeenCalled();
  });
  it.each([{ account_id: "another-account" }, { messages: [] }, { nativeSession: {} }])("rejects forged identity or context on session create: %s", async body => {
    const deps = dependencies(); expect((await handleWebsiteAgentSessionRequest(request("POST", body), "create", undefined, deps)).status).toBe(400);
    expect(deps.create).not.toHaveBeenCalled();
  });
  it("returns the same not-found response for a guessed or foreign session", async () => {
    const deps = dependencies(); vi.mocked(deps.load).mockRejectedValue(new WebsiteAgentSessionError("session_not_found"));
    const response = await handleWebsiteAgentSessionRequest(request(), "load", sessionId, deps);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: { code: "session_not_found" } });
  });
  it("propagates stale revision and expiry without guessing a newer session", async () => {
    const deps = dependencies(); vi.mocked(deps.close).mockRejectedValue(new WebsiteAgentSessionError("session_conflict"));
    expect((await handleWebsiteAgentSessionRequest(request("POST", { expected_revision: 0 }), "close", sessionId, deps)).status).toBe(409);
    vi.mocked(deps.load).mockRejectedValue(new WebsiteAgentSessionError("session_expired"));
    expect((await handleWebsiteAgentSessionRequest(request(), "load", sessionId, deps)).status).toBe(410);
  });
  it("validates IDs and expected revisions before reaching the store", async () => {
    const deps = dependencies();
    expect((await handleWebsiteAgentSessionRequest(request(), "load", "../../other", deps)).status).toBe(400);
    expect((await handleWebsiteAgentSessionRequest(request("POST", { expected_revision: -1 }), "close", sessionId, deps)).status).toBe(400);
    expect(deps.load).not.toHaveBeenCalled(); expect(deps.close).not.toHaveBeenCalled();
  });
  it("checks same-origin mutation boundaries before reading identity", async () => {
    const deps = dependencies(); expect((await handleWebsiteAgentSessionRequest(request("POST", {}, { origin: "https://evil.example" }), "create", undefined, deps)).status).toBe(400);
    expect(deps.getSession).not.toHaveBeenCalled();
  });
});
