import { identifyGenericWeb } from "@attention/collector";
import { domains, type AttentionDatabase } from "@attention/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectionPlanDigest, loadCollectionEffectPlan } from "./collection-effect-plan";
import { collectionReviewDetails, parseWebsiteCollectionPrepared, reResolveWebsiteCollection, type WebsiteCandidateChoices } from "./website-agent-collection-review";
import { parseWebsiteAgentActionProposal, preparedWebsiteCollectionProposal } from "./website-agent-action-policy";
import { pendingWebsiteAgentAction, parseStoredWebsiteAgentAction, websiteAgentActionViews } from "./website-agent-action-state";
import type { AttentionToolContext } from "./attention-tool-registry";
import { resolveExternalUrl } from "./fetcher-client";

vi.mock("./fetcher-client", () => ({ FetcherClientError: class extends Error {}, resolveExternalUrl: vi.fn(async (url: string) => ({ finalUrl: url, redirectChain: [] })) }));
export const owner = "00000000-0000-4000-8000-000000000001";
const domainId = "00000000-0000-4000-8000-000000000002";
const candidateId = "00000000-0000-4000-8000-000000000003";
const candidate2 = "00000000-0000-4000-8000-000000000004";
const source = "https://example.com/article";
const identity = identifyGenericWeb(source)!;
const candidate = { identity, aliasIdentities: [], outboundUrl: source, observedUrl: source, selectedUrl: source, redirectChain: [], displayHost: "example.com", resolutionStatus: "resolved" as const };
const context = { accountId: owner, signal: new AbortController().signal } as AttentionToolContext;
function readOnlyDb(): AttentionDatabase {
  return { select: () => ({ from: (table: unknown) => {
    const rows = Promise.resolve(table === domains ? [{ id: domainId, slug: "ai", active: true }] : []);
    return { where: () => Object.assign(rows, { limit: () => rows }) };
  } }) } as unknown as AttentionDatabase;
}
async function prepared() {
  return { kind: "collection" as const, plan: await loadCollectionEffectPlan(readOnlyDb(), owner, candidate, "public"),
    attemptInput: { idempotency_key: "server-original-operation", raw_input: source, visibility: "public" as const } };
}
function choices(): WebsiteCandidateChoices {
  return { kind: "candidate_options", attemptId: owner, pendingId: domainId, tokenHash: "a".repeat(64), vaultDigest: "b".repeat(64), visibility: "public",
    expiresAt: "2030-01-01T00:00:00.000Z", options: [candidateId, candidate2].map((candidateId, index) => ({ candidateId, url: `https://example.com/${index}`, displayHost: "example.com", source: "web", contentType: "article" })) };
}
afterEach(() => vi.clearAllMocks());
describe("website collection exact review artifacts", () => {
  it("binds all source URLs and exact normalized identity to a bounded server proposal", async () => {
    const artifact = await prepared();
    const proposal = preparedWebsiteCollectionProposal("attention_collect_content", { input: source, visibility: "public", idempotency_key: "server-original-operation" }, artifact);
    expect(parseWebsiteAgentActionProposal(JSON.parse(JSON.stringify(proposal)))).toEqual(proposal);
    expect(proposal.review.details.map(item => item.value)).toContain(source);
    expect(proposal.review.consequences.join(" ")).toContain("公开收藏者身份");
    expect(() => parseWebsiteAgentActionProposal({ ...proposal, review: { ...proposal.review, consequences: ["No side effects"] } })).toThrow();
    expect(() => parseWebsiteAgentActionProposal({ ...proposal, prepared: { ...artifact, selectionToken: "never allowed" } })).toThrow();
    expect(() => parseWebsiteCollectionPrepared({ ...artifact, plan: { ...artifact.plan, articleBody: "private text" } })).toThrow();
  });
  it("shows actual public result and every restore/delete effect instead of merely the private request", async () => {
    const artifact = await prepared();
    artifact.plan.requestedVisibility = "private";
    artifact.plan.effects = { ...artifact.plan.effects, targetDisposition: "restored", targetCollectionId: candidateId,
      resultingVisibility: "public", resultingModeration: "blocked", mergedCollectionIds: [candidate2], aliasCollectionDispositions: { [candidate2]: "restored" }, sharedOutboundChange: true };
    const { digest: _digest, ...body } = artifact.plan; artifact.plan.digest = collectionPlanDigest(body);
    const review = collectionReviewDetails(artifact);
    expect(review.details.find(detail => detail.label === "最终可见性 / 审核 / 主题")?.value).toContain("public / blocked");
    expect(review.details.find(detail => detail.label === "合并后删除的收藏")?.value).toBe(candidate2);
    expect(review.details.find(detail => detail.label === "恢复或新建的别名收藏")?.value).toContain(`${candidate2}: restored`);
    expect(review.consequences.join(" ")).toContain("其他收藏者");
  });
  it("exposes only server-owned candidate options, never vault or approval capabilities", () => {
    const proposal = preparedWebsiteCollectionProposal("attention_collect_content", { input: "https://example.com/0 https://example.com/1", visibility: "public", idempotency_key: "server-choices-key" }, choices());
    const action = pendingWebsiteAgentAction({ proposal, authSessionId: domainId, originRunId: candidateId, originRevision: 1 });
    expect(parseStoredWebsiteAgentAction(JSON.parse(JSON.stringify(action)))).toEqual(action);
    const view = websiteAgentActionViews([action], new Date())[0]!;
    expect(view.candidates).toEqual(choices().options);
    for (const secret of ["tokenHash", "vaultDigest", "pendingId", "selectionToken", "selection_token", "arguments", "prepared"]) expect(Object.hasOwn(view, secret)).toBe(false);
    expect(() => parseWebsiteCollectionPrepared({ ...choices(), options: [choices().options[0]!, choices().options[0]!] })).toThrow();
    expect(() => parseWebsiteCollectionPrepared({ ...choices(), selection_token: "secret" })).toThrow();
  });
  it("requires browser selection before an options proposal can pass source preflight", async () => {
    await expect(reResolveWebsiteCollection(context, choices())).rejects.toThrow("candidate_selection_required");
    expect(resolveExternalUrl).not.toHaveBeenCalled();
  });
  it("re-resolves before locks and rejects changed URL/identity without applying effects", async () => {
    const artifact = await prepared();
    const resolved = await reResolveWebsiteCollection(context, artifact);
    expect(resolved).toEqual({ preparedDigest: collectionPlanDigest(artifact) });
    vi.mocked(resolveExternalUrl).mockResolvedValueOnce({ finalUrl: "https://example.com/different", redirectChain: [] });
    await expect(reResolveWebsiteCollection(context, artifact)).rejects.toThrow("action_target_changed");
  });
  it("does not keep pending token, attempt row or article bodies in candidate action metadata", async () => {
    const artifact = await prepared();
    const pending = { attemptId: owner, pendingId: domainId, candidateId, tokenHash: "a".repeat(64), vaultDigest: "b".repeat(64), visibility: "public", expiresAt: "2030-01-01T00:00:00.000Z" };
    const selected = parseWebsiteCollectionPrepared({ kind: "collection", plan: artifact.plan, pending });
    expect(selected).toMatchObject({ pending });
    for (const extra of [{ selectionToken: "secret" }, { attempt: { rawInput: "private" } }, { articleBody: "private" }])
      expect(() => parseWebsiteCollectionPrepared({ kind: "collection", plan: artifact.plan, pending: { ...pending, ...extra } })).toThrow();
  });
});
