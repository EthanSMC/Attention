import { getSessionCookieName, type SessionPrincipal } from "@attention/auth";
import type { AttentionDatabase, AttentionTransaction } from "@attention/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Service from "./content-enrichment-service";
import { attentionToolRegistry, type AttentionToolBaseContext } from "./attention-tool-registry";
import { handleWebsiteAgentActionRequest, type WebsiteAgentActionRequestDependencies } from "./website-agent-action-handler";
import { invokeReviewedWebsiteDatabaseAction } from "./website-agent-action-execution";
import { preparedWebsiteEnrichmentProposal } from "./website-agent-action-policy";
import { pendingWebsiteAgentAction, websiteAgentActionViews, type StoredWebsiteAgentAction } from "./website-agent-action-state";
import type { WebsiteAgentSessionView } from "./website-agent-sessions";
import { ids, preparedFixture, runIdentity, time } from "../test-support/enrichment-review-fixtures";
const mocks = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("./content-enrichment-service", async importOriginal => ({ ...await importOriginal<typeof Service>(), applyPreparedContentEnrichment: mocks.apply }));
const token = "synthetic-cookie-token-xxxxxxxxxxxxxxxxxxxxxxxxxx";
function fixture() {
  const proposal = preparedWebsiteEnrichmentProposal(preparedFixture());
  const pending = pendingWebsiteAgentAction({ proposal, authSessionId: ids.auth, originRunId: ids.run, originRevision: 4 });
  const action: StoredWebsiteAgentAction = { ...pending, status: "executing", claimId: ids.identity, deadline: "2026-11-10T12:01:00.000Z" };
  const claim = { accountId: ids.account, sessionId: ids.session, authSessionId: ids.auth, actionId: action.id, claimId: ids.identity, revision: 6 };
  const principal = { accountId: ids.account, sessionId: ids.auth, isMember: true, isFilter: false } as SessionPrincipal;
  let effects = 0;
  const savepoint = { name: "canonical-savepoint" } as unknown as AttentionTransaction;
  const tx = { transaction: vi.fn(async (work: (tx: AttentionTransaction) => unknown) => {
    const before = effects;
    try { return await work(savepoint); } catch (e) { effects = before; throw e; }
  }) } as unknown as AttentionTransaction;
  mocks.apply.mockImplementation(async actual => {
    expect(actual).toBe(savepoint); effects += 1; return { contentId: ids.content, status: "enriched", summaryStatus: "ready" };
  });
  const context: AttentionToolBaseContext = { accountId: ids.account, isMember: true, isFilter: false, scopes: ["collection:write"],
    caller: { credentialId: ids.auth, clientId: "attention-website", credentialKind: "session", entrypoint: "hosted_agent" },
    getDatabase: () => tx, requestId: action.id, serviceOrigin: "https://attention.example" };
  const view: WebsiteAgentSessionView = { id: ids.session, revision: 7, status: "open", createdAt: time, updatedAt: time,
    expiresAt: "2026-11-17T12:00:00.000Z", pending: null, messages: [], actions: websiteAgentActionViews([pending], new Date(time)) };
  const execution = { registry: attentionToolRegistry, lockAuthority: vi.fn(async () => {}), lockTarget: vi.fn(async () => {}), revalidateProposal: vi.fn(async () => {}) };
  let receipt: unknown;
  const deps: WebsiteAgentActionRequestDependencies = { getDatabase: () => ({} as AttentionDatabase),
    getConfig: () => ({ audience: "members", accountIds: [], apiKey: "unused", dailyCostMicrousd: null, maxRunCostMicrousd: 400000 }),
    getSession: vi.fn(async () => ({ principal, shouldClearCookie: false })), resolveSession: vi.fn(async () => principal),
    claim: vi.fn(async () => ({ claim, session: view, proposal, origin: { originRunId: ids.run, originRevision: 4 } })),
    execute: vi.fn(async (_db, _claim, work) => { const result = await work(tx, action); receipt = result.receipt;
      return { value: result.value, session: { ...view, actions: websiteAgentActionViews([{ ...pending, status: "completed", receipt: result.receipt }], new Date()) } }; }),
    unknown: vi.fn(async () => {}), decline: vi.fn(async () => view), audit: vi.fn(async () => {}), preflight: vi.fn(async () => { throw new Error("No external preflight for enrichment"); }),
    invoke: vi.fn((actual, input) => invokeReviewedWebsiteDatabaseAction(actual, input, execution)) };
  const send = (extra: Record<string, unknown> = {}) => handleWebsiteAgentActionRequest(new Request("https://attention.example/api/approve", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://attention.example",
      cookie: `${getSessionCookieName(process.env.NODE_ENV === "production")}=${token}` }, body: JSON.stringify({
      approval: true, expected_revision: 5, expected_arguments_hash: action.argumentsHash, ...extra }) }), "approve", ids.session, action.id, deps);
  return { deps, send, tx, savepoint, execution, action, claim, proposal, context, effects: () => effects, receipt: () => receipt };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(time));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); })); mocks.apply.mockReset(); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("reviewed enrichment approval HTTP and canonical execution", () => {
  it("performs no network preflight and executes exact persisted args on the canonical savepoint", async () => {
    const f = fixture(), response = await f.send(); expect(response.status).toBe(200); expect(f.effects()).toBe(1);
    expect(f.deps.preflight).not.toHaveBeenCalled();
    expect(f.deps.invoke).toHaveBeenCalledWith(f.tx, expect.objectContaining({ proposal: f.proposal, enrichmentIdentity: runIdentity }));
    expect(f.execution.revalidateProposal).toHaveBeenCalledWith(expect.anything(), f.proposal, undefined, runIdentity);
    for (const call of vi.mocked(f.deps.resolveSession).mock.calls) expect(call).toEqual([f.tx, token, { touch: false }]);
    const body = await response.text(); expect(body).not.toContain('"prepared"'); expect(body).not.toContain('"arguments"');
    expect(body).not.toContain('"evidence"'); expect(body).not.toContain(token);
    expect(f.receipt()).toEqual({ ok: true, code: "completed", message: "The exact reviewed action completed." });
  });
  it("rejects replacement evidence/arguments before claiming", async () => {
    for (const extra of [{ evidence: preparedFixture().evidence }, { arguments: { summary: "Changed" } }, { originRunId: ids.run }]) {
      const f = fixture(); expect((await f.send(extra)).status).toBe(400); expect(f.deps.claim).not.toHaveBeenCalled();
    }
  });
  it("rejects mismatched trusted origin or expired source after claim with no apply and no retry", async () => {
    const f = fixture(); const original = vi.mocked(f.deps.claim).getMockImplementation()!;
    vi.mocked(f.deps.claim).mockImplementation(async (...args) => ({ ...await original(...args), origin: { originRunId: ids.identity, originRevision: 4 } }));
    expect((await f.send()).status).toBe(409); expect(f.deps.execute).not.toHaveBeenCalled(); expect(f.deps.unknown).toHaveBeenCalledTimes(1);
    const expired = fixture(); vi.setSystemTime(new Date("2026-11-10T12:02:00.000Z"));
    expect((await expired.send()).status).toBe(409); expect(expired.deps.execute).not.toHaveBeenCalled(); expect(expired.deps.unknown).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("rejects stored action/origin substitution and returns replay without executing", async () => {
    const f = fixture(); f.action.originRevision = 3;
    expect((await f.send()).status).toBe(409); expect(f.deps.invoke).not.toHaveBeenCalled();
    const replay = fixture(); const old = vi.mocked(replay.deps.claim).getMockImplementation()!;
    vi.mocked(replay.deps.claim).mockImplementation(async (...args) => ({ ...await old(...args), claim: null }));
    expect((await replay.send()).status).toBe(200); expect(replay.deps.invoke).not.toHaveBeenCalled();
  });
  it("returns a safe failed receipt rather than false success when the canonical Core throws", async () => {
    const f = fixture(); mocks.apply.mockImplementation(async () => { throw new Error("synthetic-unknown-outcome"); });
    expect((await f.send()).status).toBe(200); expect(f.receipt()).toMatchObject({ ok: false, code: "internal_error" });
    expect(f.effects()).toBe(0);
  });
  it("rejects changed target before any canonical apply", async () => {
    const f = fixture(); f.execution.revalidateProposal.mockRejectedValue(new Error("action_target_changed"));
    expect((await f.send()).status).toBe(409); expect(mocks.apply).not.toHaveBeenCalled();
    expect(f.deps.unknown).toHaveBeenCalledTimes(1);
  });
});
