import { getSessionCookieName, type SessionPrincipal } from "@attention/auth";
import type { AttentionDatabase, AttentionTransaction } from "@attention/db";
import { createNativeWebsiteSession } from "@attention/website-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleWebsiteAgentActionRequest, type WebsiteAgentActionRequestDependencies } from "./website-agent-action-handler";
import { websiteAgentActionArgumentsHash, WebsiteAgentActionPolicyError, type WebsiteAgentActionProposal } from "./website-agent-action-policy";
import { pendingWebsiteAgentAction, websiteAgentActionViews, type StoredWebsiteAgentAction } from "./website-agent-action-state";
import { handleWebsiteAgentRequest, type WebsiteAgentRequestDependencies } from "./website-agent-handler";
import { WebsiteAgentSessionError, type WebsiteAgentActionClaim, type WebsiteAgentSessionView } from "./website-agent-sessions";
import { createWebsiteAgentTools, WEBSITE_AGENT_TOOL_SCOPES } from "./website-agent-tools";

const accountId = "00000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000001";
const authSessionId = "20000000-0000-4000-8000-000000000001";
const runId = "30000000-0000-4000-8000-000000000001";
const targetId = "40000000-0000-4000-8000-000000000001";
const claimId = "50000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-10T15:00:00.000Z");
const token = "synthetic-cookie-token-never-production-123456789";
const principal = { accountId, sessionId: authSessionId, isMember: true, isFilter: true } as SessionPrincipal;
const config = { audience: "members" as const, accountIds: [], apiKey: "private-provider-credential",
  dailyCostMicrousd: null, maxRunCostMicrousd: 400_000 };
const nativeSession = createNativeWebsiteSession(sessionId);

function proposal(): WebsiteAgentActionProposal {
  const toolName = "attention_update_collection", args = { collection_id: targetId, visibility: "public" };
  return { version: 1, toolName, contractVersion: "1.7.0", arguments: args,
    argumentsHash: websiteAgentActionArgumentsHash(toolName, args), targetFingerprint: "b".repeat(64), requiredScopes: ["collection:write"],
    review: { title: "Make the exact collection public", details: [{ label: "Collection", value: "Fixture article" }],
      consequences: ["Other people may discover it."] } };
}
function actionFixture() {
  const pending = pendingWebsiteAgentAction({ proposal: proposal(), authSessionId, originRunId: runId, originRevision: 1, now });
  const action: StoredWebsiteAgentAction = { ...pending, status: "executing", claimId, deadline: new Date(now.getTime() + 60_000).toISOString() };
  const claim: WebsiteAgentActionClaim = { accountId, sessionId, actionId: action.id, authSessionId, claimId, revision: 3 };
  return { pending, action, claim };
}
function view(actions: StoredWebsiteAgentAction[] = []): WebsiteAgentSessionView {
  return { id: sessionId, revision: 4, status: "open", createdAt: now.toISOString(), updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(), pending: null, messages: [], actions: websiteAgentActionViews(actions, now) };
}
function request(actionId: string, body: Record<string, unknown>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request(`https://attention.example/api/website-agent/sessions/${sessionId}/actions/${actionId}/approve`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://attention.example", "sec-fetch-site": "same-origin",
      cookie: `${getSessionCookieName(process.env.NODE_ENV === "production")}=${token}`, ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
  });
}
function fixture() {
  const { pending, action, claim } = actionFixture();
  const db = { tag: "root-database" } as unknown as AttentionDatabase;
  const tx = { tag: "outer-transaction" } as unknown as AttentionTransaction;
  let recordedReceipt: StoredWebsiteAgentAction["receipt"] = null;
  const deps: WebsiteAgentActionRequestDependencies = {
    getDatabase: vi.fn(() => db), getSession: vi.fn(async () => ({ principal, shouldClearCookie: false })),
    getConfig: vi.fn(() => config), resolveSession: vi.fn(async () => principal),
    claim: vi.fn(async () => ({ claim, session: view([action]) })),
    execute: vi.fn(async (_db, _claim, execute) => {
      const result = await execute(tx, action);
      recordedReceipt = result.receipt;
      return { session: view([{ ...pending, status: result.receipt.ok ? "completed" : "failed", receipt: result.receipt }]), value: result.value };
    }),
    unknown: vi.fn(async () => {}), decline: vi.fn(async () => view([{ ...pending, status: "cancelled" }])),
    invoke: vi.fn(async () => ({ result: { ok: true as const, value: { private_raw_result: "RAW_CORE_RESULT_MUST_NOT_LEAK", secret: token } }, audits: [] })),
    audit: vi.fn(async () => {}),
  };
  const approval = { expected_revision: 2, expected_arguments_hash: pending.argumentsHash, approval: true };
  const send = (body = approval, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    handleWebsiteAgentActionRequest(request(action.id, body, headers, signal), "approve", sessionId, action.id, deps);
  return { deps, db, tx, pending, action, claim, approval, send, receipt: () => recordedReceipt };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network_not_allowed_in_action_tests"); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("human-reviewed action HTTP boundary", () => {
  it.each([{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { "content-length": "4097" }])(
    "rejects an untrusted origin or oversized request before authentication: %s", async headers => {
      const f = fixture(), response = await f.send(f.approval, headers);
      expect(response.status).toBe(headers["content-length"] ? 413 : 400);
      expect(f.deps.getSession).not.toHaveBeenCalled(); expect(f.deps.claim).not.toHaveBeenCalled();
    });
  it("requires a valid website cookie even if a dependency reports an authenticated principal", async () => {
    for (const cookie of ["", "attention_session=short", "another_cookie=" + token]) {
      const f = fixture();
      expect((await f.send(f.approval, { cookie, authorization: `Bearer ${token}` })).status).toBe(401);
      expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.deps.invoke).not.toHaveBeenCalled();
    }
  });
  it.each([null, { ...principal, isMember: false }])("requires a current Member session: %s", async identity => {
    const f = fixture(); vi.mocked(f.deps.getSession).mockResolvedValue({ principal: identity, shouldClearCookie: identity === null });
    const response = await f.send();
    expect(response.status).toBe(identity ? 403 : 401);
    if (!identity) expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.deps.claim).not.toHaveBeenCalled();
  });
  it.each([{ approval: false }, { approval: "true" }, { expected_revision: -1 }, { expected_arguments_hash: "bad" },
    { arguments: { collection_id: targetId, visibility: "private" } }, { toolName: "attention_cast_moderation_vote" },
    { accountId: targetId }, { authSessionId: targetId }, { scopes: ["collection:write"] }, { messages: [] }])(
    "rejects replacement arguments, identity, scope and malformed approval: %s", async change => {
      const f = fixture();
      expect((await f.send({ ...f.approval, ...change } as typeof f.approval)).status).toBe(400);
      expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.deps.execute).not.toHaveBeenCalled(); expect(f.deps.unknown).not.toHaveBeenCalled();
    });
  it("checks rollover/rollout before committing a claim", async () => {
    const f = fixture();
    vi.mocked(f.deps.getSession).mockResolvedValueOnce({ principal, shouldClearCookie: false })
      .mockResolvedValueOnce({ principal: { ...principal, sessionId: targetId }, shouldClearCookie: false });
    expect((await f.send()).status).toBe(403); expect(f.deps.claim).not.toHaveBeenCalled();
    const gated = fixture(); vi.mocked(gated.deps.getConfig).mockReturnValue({ ...config, audience: "allowlist", accountIds: [targetId] });
    expect((await gated.send()).status).toBe(403); expect(gated.deps.claim).not.toHaveBeenCalled();
  });
  it("claims the exact hash using trusted identity, then resolves the cookie only on the effect transaction with touch:false", async () => {
    const f = fixture(), response = await f.send();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.deps.claim).toHaveBeenCalledWith(f.db, { accountId, sessionId, actionId: f.action.id, authSessionId,
      expectedRevision: 2, argumentsHash: f.pending.argumentsHash });
    expect(f.deps.resolveSession).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(f.deps.resolveSession).mock.calls) expect(call).toEqual([f.tx, token, { touch: false }]);
    const invocation = vi.mocked(f.deps.invoke).mock.calls[0]!;
    expect(invocation[0]).toBe(f.tx); expect(invocation[1].context.getDatabase()).toBe(f.tx);
    expect(invocation[1].proposal).toEqual(proposal());
    expect(f.receipt()).toEqual({ ok: true, code: "completed", message: "The exact reviewed action completed." });
    const text = await response.text();
    for (const secret of [token, "private-provider-credential", "RAW_CORE_RESULT_MUST_NOT_LEAK", "requiredScopes", "authSessionId", "originRunId", "claimId", '"arguments":'])
      expect(text).not.toContain(secret);
    expect(f.deps.unknown).not.toHaveBeenCalled();
  });
  it("flushes captured audits on the root database only after the effect transaction returned", async () => {
    const f = fixture();
    const audit = { accountId, toolName: "attention_update_collection", contractVersion: "1.7.0", credentialId: authSessionId,
      credentialKind: "session" as const, durationMs: 1, entitlementTier: "filter" as const, entrypoint: "hosted_agent" as const,
      outcome: "success" as const, requestId: f.action.id };
    vi.mocked(f.deps.invoke).mockResolvedValue({ result: { ok: true, value: {} }, audits: [audit] });
    expect((await f.send()).status).toBe(200);
    expect(f.deps.audit).toHaveBeenCalledWith(f.db, audit);
    expect(vi.mocked(f.deps.audit).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(f.deps.execute).mock.invocationCallOrder[0]!);
  });
  it.each(["attention_report_content", "attention_cast_moderation_vote"] as const)(
    "describes duplicate %s truthfully without claiming a new submission or exposing the raw result", async toolName => {
      const f = fixture();
      const args = toolName === "attention_report_content"
        ? { public_content_id: targetId, reason_code: "spam", details: "Newly reviewed details" }
        : { case_id: targetId, decision: "hidden" };
      const updated: WebsiteAgentActionProposal = { ...proposal(), toolName, arguments: args,
        argumentsHash: websiteAgentActionArgumentsHash(toolName, args),
        requiredScopes: [toolName === "attention_report_content" ? "moderation:write" : "moderation:court:vote"] };
      Object.assign(f.action, updated); Object.assign(f.pending, updated);
      f.approval.expected_arguments_hash = updated.argumentsHash;
      vi.mocked(f.deps.invoke).mockResolvedValue({ result: { ok: true, value: { duplicate: true, details: "RAW_EXISTING_REPORT_DETAILS" } }, audits: [] });
      const response = await f.send(); expect(response.status).toBe(200);
      expect(f.receipt()).toMatchObject({ ok: true, code: toolName === "attention_report_content" ? "already_reported" : "already_voted" });
      expect(f.receipt()!.message).toContain("No new");
      expect(f.receipt()!.message).not.toContain("exact reviewed action completed");
      const text = await response.text(); expect(text).not.toContain("RAW_EXISTING_REPORT_DETAILS");
      expect(text).not.toContain("Newly reviewed details");
    });
  it.each(["completed", "executing", "unknown", "cancelled"] as const)("replayed %s approval returns existing state without executing", async status => {
    const f = fixture();
    const replay = status === "executing" ? f.action : { ...f.pending, status,
      receipt: status === "completed" || status === "unknown" ? { ok: status === "completed", code: status, message: "Existing outcome" } : null };
    vi.mocked(f.deps.claim).mockResolvedValue({ claim: null, session: view([replay]) });
    expect((await f.send()).status).toBe(200);
    expect(f.deps.execute).not.toHaveBeenCalled(); expect(f.deps.invoke).not.toHaveBeenCalled();
    expect(f.deps.resolveSession).not.toHaveBeenCalled(); expect(f.deps.unknown).not.toHaveBeenCalled();
  });
  it.each(["before", "after"])("revocation %s Core rolls back execution and reconciles only the exact consumed claim", async boundary => {
    const f = fixture();
    if (boundary === "before") vi.mocked(f.deps.resolveSession).mockResolvedValue(null);
    else vi.mocked(f.deps.resolveSession).mockResolvedValueOnce(principal).mockResolvedValueOnce(null);
    expect((await f.send()).status).toBe(403);
    expect(f.receipt()).toBeNull(); expect(f.deps.invoke).toHaveBeenCalledTimes(boundary === "before" ? 0 : 1);
    expect(f.deps.unknown).toHaveBeenCalledExactlyOnceWith(f.db, f.claim);
  });
  it("withholds the response after post-commit revocation without downgrading a committed receipt to unknown", async () => {
    const f = fixture();
    vi.mocked(f.deps.getSession).mockResolvedValueOnce({ principal, shouldClearCookie: false })
      .mockResolvedValueOnce({ principal, shouldClearCookie: false }).mockResolvedValueOnce({ principal: null, shouldClearCookie: true });
    const response = await f.send();
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: { code: "permission_revoked" } });
    expect(f.receipt()?.ok).toBe(true); expect(f.deps.unknown).not.toHaveBeenCalled();
  });
  it("returns only stable errors and never retries an uncertain execution or reconciliation", async () => {
    const f = fixture();
    vi.mocked(f.deps.execute).mockRejectedValue(new Error("RAW_DATABASE_SECRET"));
    vi.mocked(f.deps.unknown).mockRejectedValue(new Error("RAW_RECONCILIATION_SECRET"));
    const response = await f.send();
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: { code: "action_outcome_unknown" } });
    expect(f.deps.execute).toHaveBeenCalledTimes(1); expect(f.deps.unknown).toHaveBeenCalledTimes(1); expect(f.deps.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/RAW_DATABASE|RAW_RECONCILIATION/);
  });
  it("does not invent a claim after an uncertain claim acknowledgement", async () => {
    const f = fixture(); vi.mocked(f.deps.claim).mockRejectedValue(new Error("lost_ack"));
    expect((await f.send()).status).toBe(503); expect(f.deps.claim).toHaveBeenCalledTimes(1);
    expect(f.deps.execute).not.toHaveBeenCalled(); expect(f.deps.unknown).not.toHaveBeenCalled();
  });
  it("reports policy and expiry failures without executing a second time", async () => {
    for (const failure of [new WebsiteAgentActionPolicyError("action_target_changed"), new WebsiteAgentSessionError("action_expired")]) {
      const f = fixture(); vi.mocked(f.deps.execute).mockRejectedValue(failure);
      const response = await f.send(); expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: failure.code } });
      expect(f.deps.unknown).toHaveBeenCalledExactlyOnceWith(f.db, f.claim);
    }
  });
  it("declines only the chosen owned action and never enters the execution path", async () => {
    const f = fixture();
    const response = await handleWebsiteAgentActionRequest(request(f.action.id, { expected_revision: 2 }), "decline", sessionId, f.action.id, f.deps);
    expect(response.status).toBe(200); expect(f.deps.decline).toHaveBeenCalledWith(f.db, { accountId, sessionId, actionId: f.action.id, expectedRevision: 2 });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.deps.invoke).not.toHaveBeenCalled();
    expect((await handleWebsiteAgentActionRequest(request(f.action.id, f.approval), "decline", sessionId, f.action.id, f.deps)).status).toBe(400);
  });
});

describe("website query proposal accumulation", () => {
  function queryFixture() {
    vi.stubEnv("ATTENTION_HMAC_SECRET", "synthetic-action-handler-hmac-never-production-123456");
    const db = {} as AttentionDatabase;
    const deps: WebsiteAgentRequestDependencies = { getDatabase: () => db,
      getSession: vi.fn(async () => ({ principal, shouldClearCookie: false })), getConfig: () => config,
      begin: vi.fn(async () => ({ accountId, sessionId, runId, revision: 1, nativeSession })), isActive: vi.fn(async () => true),
      finish: vi.fn(async (_db, input) => view(input.proposedActions)), createTools: vi.fn(createWebsiteAgentTools),
      prepareAction: vi.fn(async () => proposal()),
      run: vi.fn(async () => ({ answer: "Review the proposed action below.", nativeSession, toolReceipts: [],
        usage: { modelCalls: 1, toolCalls: 1, inputTokens: 10, outputTokens: 10, observedCostMicrousd: 1, reservedCostMicrousd: 400000 } })),
    };
    const request = () => new Request("https://attention.example/api/website-agent/query", { method: "POST",
      headers: { "content-type": "application/json", origin: "https://attention.example" }, body: JSON.stringify({ query: "Make the collection public",
        session_id: sessionId, expected_revision: 0, operation_id: runId, data_consent: true, collect: false, read_sources: false }) });
    return { deps, request };
  }
  it("full canonical metadata scopes allow proposals but not source reads or collecting without consent", async () => {
    const f = queryFixture(), run = vi.mocked(f.deps.run).getMockImplementation()!;
    vi.mocked(f.deps.run).mockImplementation(async options => {
      const adapter = vi.mocked(f.deps.createTools).mock.calls[0]![0];
      expect(adapter.context.scopes).toEqual([...WEBSITE_AGENT_TOOL_SCOPES]);
      const execution = { signal: new AbortController().signal, toolCallId: "propose-1" };
      const tools = Object.fromEntries(options.tools.map(tool => [tool.name, tool]));
      expect(await tools.attention_collect_content!.invoke({}, execution)).toMatchObject({ code: "collection_consent_required" });
      expect(await tools.attention_read_collection_source!.invoke({}, execution)).toMatchObject({ code: "source_read_consent_required" });
      expect(await tools.attention_update_collection!.invoke(proposal().arguments, execution)).toMatchObject({ ok: true, value: { status: "requires_user_confirmation" } });
      return run(options);
    });
    const response = await handleWebsiteAgentRequest(f.request(), f.deps);
    expect(response.status).toBe(200);
    const finish = vi.mocked(f.deps.finish).mock.calls[0]![1];
    expect(finish.proposedActions).toHaveLength(1);
    expect(finish.proposedActions![0]).toMatchObject({ authSessionId, originRunId: runId, originRevision: 1, status: "pending", arguments: proposal().arguments });
    const text = await response.text();
    expect(text).toContain("Make the exact collection public");
    expect(text).not.toMatch(/"arguments":|authSessionId|originRunId|targetFingerprint|private-provider-credential/);
  });
  it("persists at most four proposals only after the native turn succeeds", async () => {
    const f = queryFixture(), run = vi.mocked(f.deps.run).getMockImplementation()!;
    vi.mocked(f.deps.run).mockImplementation(async options => {
      const callback = vi.mocked(f.deps.createTools).mock.calls[0]![0].proposeAction!;
      for (let index = 0; index < 5; index++) {
        const result = await callback("attention_update_collection", proposal().arguments, { signal: new AbortController().signal, toolCallId: `p-${index}` });
        expect(result).toMatchObject(index === 4 ? { ok: false, code: "action_proposal_limit" } : { ok: true });
      }
      return run(options);
    });
    expect((await handleWebsiteAgentRequest(f.request(), f.deps)).status).toBe(200);
    expect(f.deps.prepareAction).toHaveBeenCalledTimes(4); expect(vi.mocked(f.deps.finish).mock.calls[0]![1].proposedActions).toHaveLength(4);
  });
  it("keeps the exact digest recipient in the browser review, never the model tool result or native input", async () => {
    const f = queryFixture(), run = vi.mocked(f.deps.run).getMockImplementation()!;
    const email = "browser-review-recipient@example.test";
    const args = { enabled: true, domain_slugs: ["ai"], timezone: "Asia/Shanghai", window_start: "08:00", window_minutes: 60 };
    const digest: WebsiteAgentActionProposal = { ...proposal(), toolName: "attention_update_digest_settings", arguments: args,
      argumentsHash: websiteAgentActionArgumentsHash("attention_update_digest_settings", args), requiredScopes: ["digest:write"],
      review: { title: "Change digest delivery", details: [{ label: "Delivery email", value: email }], consequences: ["Recurring delivery"] } };
    vi.mocked(f.deps.prepareAction!).mockResolvedValue(digest);
    vi.mocked(f.deps.run).mockImplementation(async options => {
      expect(JSON.stringify(options.nativeSession)).not.toContain(email);
      expect(options.prompt).not.toContain(email);
      const callback = vi.mocked(f.deps.createTools).mock.calls[0]![0].proposeAction!;
      const toolResult = await callback(digest.toolName, args, { signal: new AbortController().signal, toolCallId: "digest-1" });
      expect(toolResult).toMatchObject({ ok: true, value: { action_title: "Change digest delivery", status: "requires_user_confirmation" } });
      expect(JSON.stringify(toolResult)).not.toContain(email);
      expect(JSON.stringify(toolResult)).not.toContain('"review"');
      return run(options);
    });
    const response = await handleWebsiteAgentRequest(f.request(), f.deps);
    expect(response.status).toBe(200); expect(await response.text()).toContain(email);
    const finish = vi.mocked(f.deps.finish).mock.calls[0]![1];
    expect(JSON.stringify(finish.nativeSession)).not.toContain(email);
    expect(JSON.stringify(finish.proposedActions)).toContain(email);
  });
  it("does not persist prepared action authority after generation failure or a revoked source turn", async () => {
    for (const revoked of [false, true]) {
      const f = queryFixture();
      vi.mocked(f.deps.run).mockImplementation(async () => {
        const callback = vi.mocked(f.deps.createTools).mock.calls[0]![0].proposeAction!;
        await callback("attention_update_collection", proposal().arguments, { signal: new AbortController().signal, toolCallId: "p-1" });
        if (revoked) vi.mocked(f.deps.getSession).mockResolvedValue({ principal: null, shouldClearCookie: true });
        throw new Error("PRIVATE_PROVIDER_DETAIL");
      });
      const response = await handleWebsiteAgentRequest(f.request(), f.deps);
      expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE_PROVIDER_DETAIL");
      expect(vi.mocked(f.deps.finish).mock.calls[0]![1]).not.toHaveProperty("proposedActions");
    }
  });
  it("discards a proposal when current authority is revoked while preparing its target", async () => {
    const f = queryFixture(), run = vi.mocked(f.deps.run).getMockImplementation()!;
    vi.mocked(f.deps.prepareAction!).mockImplementation(async () => {
      vi.mocked(f.deps.getSession).mockResolvedValue({ principal: null, shouldClearCookie: true });
      return proposal();
    });
    vi.mocked(f.deps.run).mockImplementation(async options => {
      const callback = vi.mocked(f.deps.createTools).mock.calls[0]![0].proposeAction!;
      expect(await callback("attention_update_collection", proposal().arguments, { signal: new AbortController().signal, toolCallId: "p-1" }))
        .toMatchObject({ ok: false, code: "permission_revoked" });
      return run(options);
    });
    expect((await handleWebsiteAgentRequest(f.request(), f.deps)).status).toBe(502);
    expect(vi.mocked(f.deps.finish).mock.calls[0]![1]).not.toHaveProperty("proposedActions");
  });
});
