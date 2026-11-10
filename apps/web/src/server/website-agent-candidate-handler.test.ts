import { getSessionCookieName, type SessionPrincipal } from "@attention/auth";
import { identifyGenericWeb } from "@attention/collector";
import { domains, type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { describe, expect, it, vi } from "vitest";
import { handleWebsiteAgentCandidateRequest, type WebsiteAgentCandidateRequestDependencies } from "./website-agent-candidate-handler";
import { preparedWebsiteCollectionProposal } from "./website-agent-action-policy";
import { pendingWebsiteAgentAction, websiteAgentActionViews } from "./website-agent-action-state";
import { loadCollectionEffectPlan } from "./collection-effect-plan";
import type { WebsiteAgentSessionView } from "./website-agent-sessions";
import type { WebsiteCandidateChoices, WebsitePreparedCollection } from "./website-agent-collection-review";

const owner = "00000000-0000-4000-8000-000000000001", sessionId = "00000000-0000-4000-8000-000000000002";
const authSessionId = "00000000-0000-4000-8000-000000000003", runId = "00000000-0000-4000-8000-000000000004";
const candidateId = "00000000-0000-4000-8000-000000000005", otherCandidate = "00000000-0000-4000-8000-000000000006";
const principal = { accountId: owner, sessionId: authSessionId, isMember: true, isFilter: true } as SessionPrincipal;
const choices: WebsiteCandidateChoices = { kind: "candidate_options", attemptId: owner, pendingId: sessionId, tokenHash: "a".repeat(64), vaultDigest: "b".repeat(64),
  visibility: "public", expiresAt: "2030-01-01T00:00:00.000Z", options: [candidateId, otherCandidate].map((id, i) => ({ candidateId: id,
    url: `https://example.com/${i}`, displayHost: "example.com", source: "generic_web", contentType: "article" })) };
async function fixture() {
  const identity = identifyGenericWeb(choices.options[0]!.url)!;
  const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db), select: () => ({ from: (table: unknown) => {
    const rows = Promise.resolve(table === domains ? [{ id: runId, slug: "ai", active: true }] : []);
    return { where: () => Object.assign(rows, { limit: () => rows }) };
  } }) } as unknown as AttentionDatabase;
  const tx = { tag: "effect-transaction" } as unknown as AttentionTransaction;
  const plan = await loadCollectionEffectPlan(db, owner, { identity, aliasIdentities: [], outboundUrl: identity.normalizedUrl, observedUrl: identity.normalizedUrl,
    selectedUrl: identity.normalizedUrl, redirectChain: [], displayHost: "example.com", resolutionStatus: "resolved" }, "public");
  const prepared: WebsitePreparedCollection = { kind: "collection", plan, pending: { attemptId: choices.attemptId, pendingId: choices.pendingId,
    tokenHash: choices.tokenHash, vaultDigest: choices.vaultDigest, expiresAt: choices.expiresAt, visibility: choices.visibility, candidateId } };
  const proposal = preparedWebsiteCollectionProposal("attention_collect_content", { input: choices.options.map(item => item.url).join(" "), visibility: "public", idempotency_key: "server-owned-idempotency" }, choices);
  const original = pendingWebsiteAgentAction({ proposal, authSessionId, originRunId: runId, originRevision: 1 });
  const view: WebsiteAgentSessionView = { id: sessionId, revision: 3, status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: choices.expiresAt, pending: null, messages: [], actions: websiteAgentActionViews([original], new Date()) };
  const deps: WebsiteAgentCandidateRequestDependencies = {
    getDatabase: vi.fn(() => db), getSession: vi.fn(async () => ({ principal, shouldClearCookie: false })),
    getConfig: vi.fn(() => ({ audience: "members" as const, accountIds: [], apiKey: "offline", dailyCostMicrousd: null, maxRunCostMicrousd: 400000 })),
    load: vi.fn(async () => original), prepare: vi.fn(async () => prepared),
    replace: vi.fn(async (_db, input) => { if (!await input.revalidate(tx)) throw new Error("permission_revoked"); return view; }),
    resolveSession: vi.fn(async () => principal), lockAuthority: vi.fn(async () => {}),
  };
  const body = { expected_revision: 2, expected_arguments_hash: original.argumentsHash, candidate_id: candidateId };
  const request = (input = body, headers: Record<string, string> = {}) => new Request(`https://attention.example/api/website-agent/sessions/${sessionId}/actions/${original.id}/select`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://attention.example", "sec-fetch-site": "same-origin",
      cookie: `${getSessionCookieName(process.env.NODE_ENV === "production")}=synthetic-cookie-token-123456789`, ...headers }, body: JSON.stringify(input),
  });
  return { deps, original, prepared, body, request, tx, send: (req = request()) => handleWebsiteAgentCandidateRequest(req, sessionId, original.id, deps) };
}
describe("human candidate preparation boundary", () => {
  it("resolves one server option before its brief replacement transaction and never invokes an effect", async () => {
    const f = await fixture();
    expect((await f.send()).status).toBe(200);
    expect(f.deps.prepare).toHaveBeenCalledWith(expect.objectContaining({ accountId: owner }), choices, candidateId);
    expect(f.deps.replace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ original: f.original,
      proposal: expect.objectContaining({ toolName: "attention_select_collection_candidate", prepared: f.prepared }) }));
    expect(f.deps.resolveSession).toHaveBeenCalledWith(f.tx, expect.any(String), { touch: false });
    expect(vi.mocked(f.deps.prepare).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.deps.replace).mock.invocationCallOrder[0]!);
  });
  it.each([{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }])("rejects cross-origin choices before private reads", async headers => {
    const f = await fixture();
    expect((await f.send(f.request(f.body, headers))).status).toBe(400);
    expect(f.deps.load).not.toHaveBeenCalled();
  });
  it("rejects client approval, tokens and rewritten source URLs", async () => {
    for (const extra of [{ approval: true }, { selection_token: "secret" }, { url: "https://evil.example/" }]) {
      const f = await fixture();
      expect((await f.send(f.request({ ...f.body, ...extra }))).status).toBe(400);
      expect(f.deps.prepare).not.toHaveBeenCalled();
    }
  });
  it("withholds replacement when final cookie authentication changed", async () => {
    const f = await fixture(); vi.mocked(f.deps.resolveSession).mockResolvedValue(null);
    expect((await f.send()).status).toBe(403);
    expect(f.deps.resolveSession).toHaveBeenCalledWith(f.tx, expect.any(String), { touch: false });
  });
  it("blocks public selection without current Filter access", async () => {
    const f = await fixture(); vi.mocked(f.deps.getSession).mockResolvedValue({ principal: { ...principal, isFilter: false }, shouldClearCookie: false });
    expect((await f.send()).status).toBe(403);
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
});
