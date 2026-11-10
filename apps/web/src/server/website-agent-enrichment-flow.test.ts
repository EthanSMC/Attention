import type { SessionPrincipal } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { ReadRequest, ReadResult } from "@attention/content-reader-contracts";
import { createNativeWebsiteSession } from "@attention/website-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";
import type * as Coordinator from "./source-read-coordinator";
import type * as Status from "./collection-status-service";
import type * as Plans from "./content-enrichment-plan";
import { buildContentEnrichmentPlan } from "./content-enrichment-plan";
import { handleWebsiteAgentRequest, type WebsiteAgentRequestDependencies } from "./website-agent-handler";
import { createWebsiteAgentTools } from "./website-agent-tools";
import { parseWebsiteAgentActionProposal, preparedWebsiteEnrichmentProposal } from "./website-agent-action-policy";
import { pendingWebsiteAgentAction, parseStoredWebsiteAgentAction } from "./website-agent-action-state";
import { decryptWebsiteAgentSessionState, encryptWebsiteAgentSessionState } from "./website-agent-sessions";
import { ids, enrichmentInput, finalUrl, preparedFixture, runIdentity, snapshot, status, time } from "../test-support/enrichment-review-fixtures";
const mocks = vi.hoisted(() => ({ read: vi.fn(), status: vi.fn(), loadPlan: vi.fn() }));
vi.mock("./fetcher-client", async importOriginal => ({ ...await importOriginal<object>(), readExternalSource: mocks.read }));
vi.mock("./collection-status-service", async importOriginal => ({ ...await importOriginal<typeof Status>(), getCollectionStatus: mocks.status }));
vi.mock("./content-enrichment-plan", async importOriginal => ({ ...await importOriginal<typeof Plans>(), loadContentEnrichmentPlan: mocks.loadPlan }));
vi.mock("./source-read-coordinator", async importOriginal => ({ ...await importOriginal<typeof Coordinator>(), createSourceReadCoordinator: () => ({
  consumeInvocation: async () => ({ allowed: true, retryAfterMs: 0 }), acquire: async () => ({ allowed: true, reference: ids.run }),
  heartbeat: async () => true, release: async () => {}, browserInspect: async () => null, browserClaim: async () => null,
  browserStatus: async () => null, browserRelease: async () => false,
}) }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof NextServer>(), after: vi.fn() }));
const principal = { accountId: ids.account, sessionId: ids.auth, isMember: true, isFilter: false } as SessionPrincipal;
const nativeSession = createNativeWebsiteSession(ids.session);
function fixture(read = true) {
  const receipts: unknown[] = [];
  const deps: WebsiteAgentRequestDependencies = { getDatabase: () => ({} as AttentionDatabase),
    getSession: vi.fn(async () => ({ principal, shouldClearCookie: false })),
    getConfig: () => ({ audience: "members", accountIds: [], apiKey: "synthetic-key", dailyCostMicrousd: null, maxRunCostMicrousd: 400000 }),
    begin: vi.fn(async () => ({ accountId: ids.account, sessionId: ids.session, runId: ids.run, revision: runIdentity.originRevision, nativeSession })),
    isActive: vi.fn(async () => true), finish: vi.fn(async () => ({ id: ids.session, revision: 5, status: "open" as const, pending: null,
      createdAt: time, updatedAt: time, expiresAt: "2026-11-17T12:00:00.000Z", messages: [] })), createTools: createWebsiteAgentTools,
    run: vi.fn(async (options: Parameters<WebsiteAgentRequestDependencies["run"]>[0]) => {
      const execution = { signal: new AbortController().signal, toolCallId: "synthetic-call" };
      if (read) receipts.push(await options.tools.find(tool => tool.name === "attention_read_collection_source")!.invoke(
        { collection_id: ids.collection, attempt_ref: "model-proof-cannot-authorize" }, execution));
      receipts.push(await options.tools.find(tool => tool.name === "attention_submit_content_enrichment")!.invoke(enrichmentInput, execution));
      return { answer: "Review the proposed shared changes.", nativeSession, toolReceipts: [], usage: {
        inputTokens: 1, outputTokens: 1, modelCalls: 1, toolCalls: 2, observedCostMicrousd: 1, reservedCostMicrousd: 2 } };
    }),
  };
  const request = (read_sources = true) => new Request("https://attention.example/api/website-agent/query", { method: "POST",
    headers: { origin: "https://attention.example", "content-type": "application/json" }, body: JSON.stringify({ query: "Read and propose a grounded summary",
      session_id: ids.session, expected_revision: 3, operation_id: ids.run, data_consent: true, read_sources }) });
  return { deps, request, receipts };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(time));
  vi.stubEnv("ATTENTION_HMAC_SECRET", "synthetic-hmac-for-offline-test-at-least32");
  vi.stubEnv("ATTENTION_WEBSITE_AGENT_SESSION_SECRET", "synthetic-independent-session-test-at-least32");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); }));
  mocks.status.mockReset().mockImplementation(async () => status());
  mocks.loadPlan.mockReset().mockImplementation(async () => buildContentEnrichmentPlan(enrichmentInput, snapshot()));
  mocks.read.mockReset().mockImplementation(async (request: ReadRequest): Promise<ReadResult> => ({ schema_version: 1,
    request_ref: request.request_ref, attempt_ref: request.attempt_ref, outcome: "ready", evidence_kind: "article", source_kind: "generic_web",
    final_public_url: finalUrl, extraction_method: "readability", temporary_text: "RAW_ARTICLE_NEVER_PERSIST_THIS",
    read_at: time, truncated: false, attempts: [{ method: "static", duration_ms: 1 }], metadata: { title: null, author: null, description: null, published_at: null } }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("website enrichment source-to-review wiring", () => {
  it("uses the actual reader override and exact server run identity before storing only metadata", async () => {
    const f = fixture(); expect((await handleWebsiteAgentRequest(f.request(), f.deps)).status).toBe(200);
    expect(f.receipts[0]).toMatchObject({ ok: true, value: { outcome: "ready" } });
    expect(f.receipts[1]).toMatchObject({ ok: true, value: { status: "requires_user_confirmation" } });
    const saved = vi.mocked(f.deps.finish).mock.calls[0]![1].proposedActions![0]!;
    expect(saved.prepared).toMatchObject({ kind: "enrichment", evidence: runIdentity });
    expect(saved.expiresAt).toBe("2026-11-10T12:02:00.000Z");
    expect(JSON.stringify(saved)).not.toContain("RAW_ARTICLE");
    expect(JSON.stringify(f.receipts[1])).not.toContain(enrichmentInput.summary);
    expect(JSON.stringify(f.receipts[1])).not.toContain("evidence");
    expect(mocks.read.mock.calls[0]?.[0]).toMatchObject({ request_ref: `website-evidence:${ids.run}` });
    const encrypted = encryptWebsiteAgentSessionState({ accountId: ids.account, sessionId: ids.session, revision: 5,
      state: { version: 2, nativeSession, pending: null, actions: [saved] } });
    const decoded = decryptWebsiteAgentSessionState({ accountId: ids.account, sessionId: ids.session, revision: 5, encryptedState: encrypted });
    expect(JSON.stringify(decoded)).not.toContain("RAW_ARTICLE");
  });
  it.each([false, true])("rejects enrichment with no attested read (read consent %s)", async consent => {
    const f = fixture(!consent); expect((await handleWebsiteAgentRequest(f.request(consent), f.deps)).status).toBe(200);
    expect(f.receipts.at(-1)).toMatchObject({ ok: false, code: "source_evidence_required" });
    expect(vi.mocked(f.deps.finish).mock.calls[0]![1].proposedActions).toBeUndefined();
  });
  it("does not create a review after current-run authority is revoked", async () => {
    const f = fixture(false); vi.mocked(f.deps.isActive).mockResolvedValue(false);
    await handleWebsiteAgentRequest(f.request(), f.deps);
    expect(f.receipts[0]).toMatchObject({ ok: false, code: "permission_revoked" });
    expect(mocks.loadPlan).not.toHaveBeenCalled();
  });
  it("strictly binds exact normalized args, review, origin, owner/session and expiry", () => {
    const proposal = preparedWebsiteEnrichmentProposal(preparedFixture());
    expect(parseWebsiteAgentActionProposal(proposal)).toEqual(proposal);
    for (const changed of [{ ...proposal, arguments: { ...proposal.arguments, title: "Replacement" } },
      { ...proposal, review: { ...proposal.review, consequences: ["No shared effects"] } },
      { ...proposal, prepared: undefined }]) expect(() => parseWebsiteAgentActionProposal(changed)).toThrow("action_invalid_proposal");
    const action = pendingWebsiteAgentAction({ proposal, authSessionId: ids.auth, originRunId: ids.run, originRevision: 4 });
    for (const changed of [{ ...action, authSessionId: ids.run }, { ...action, originRevision: 3 },
      { ...action, expiresAt: "2026-11-10T12:03:00.000Z" }]) expect(() => parseStoredWebsiteAgentAction(changed)).toThrow();
    expect(() => encryptWebsiteAgentSessionState({ accountId: ids.auth, sessionId: ids.session, revision: 5,
      state: { version: 2, nativeSession, pending: null, actions: [action] } })).toThrow("session_unavailable");
  });
});
