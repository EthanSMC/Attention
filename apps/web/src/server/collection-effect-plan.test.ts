import { describe, expect, it, vi } from "vitest";
import { identifyGenericWeb } from "@attention/collector";
import { collections, contentAliases, contentIdentities, contents, domains, jobs, type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { collectionPlanDigest, loadCollectionEffectPlan, parseCollectionEffectPlan } from "./collection-effect-plan";
import { establishPreparedCollection, parsePendingCandidateBinding, resolveCollectionInput, type ResolvedCandidate } from "./collection-service";
import { collectionReviewDetails } from "./website-agent-collection-review";

vi.mock("./fetcher-client", () => ({ FetcherClientError: class extends Error {}, resolveExternalUrl: vi.fn(async (url: string) => ({ finalUrl: url, redirectChain: [] })) }));
const owner = "00000000-0000-4000-8000-000000000001";
const domainId = "00000000-0000-4000-8000-000000000002";
const contentId = "00000000-0000-4000-8000-000000000003";
const collectionId = "00000000-0000-4000-8000-000000000004";
const aliasId = "00000000-0000-4000-8000-000000000005";
const date = "2026-01-01T00:00:00.000Z";
const identity = identifyGenericWeb("https://example.com/article")!;
const candidate: ResolvedCandidate = { identity, aliasIdentities: [], outboundUrl: identity.normalizedUrl, observedUrl: identity.normalizedUrl, selectedUrl: identity.normalizedUrl, redirectChain: [], displayHost: "example.com", resolutionStatus: "resolved" };
const content = { id: contentId, source: "web", normalizedUrl: candidate.outboundUrl, outboundUrl: candidate.outboundUrl, enrichmentStatus: "pending", contentStatus: "active", publicSafetyStatus: "allowed", takedownStatus: "none", communityModerationStatus: "clear", visibilityVersion: 0 };
const collection = { id: collectionId, accountId: owner, contentId, domainId, visibility: "private", collectedAt: date, publicSince: null, sourceChannel: "web", collectionStatus: "active", filterRevokedAt: null, moderationStatus: "clear", createdAt: date, updatedAt: date };
const identityRow = { id: "00000000-0000-4000-8000-000000000006", contentId, dedupeKey: identity.dedupeKey, identityKind: "normalized", normalizedUrl: identity.normalizedUrl, sourceAdapter: identity.adapter, adapterVersion: identity.adapterVersion, active: true, createdAt: date };
function readOnlyDb(overrides: Map<unknown, unknown[]> = new Map()) {
  const data = new Map<unknown, unknown[]>([[domains, [{ id: domainId, slug: "ai", active: true }]], [contents, []], [collections, []], [contentIdentities, []], [contentAliases, []], [jobs, []], ...overrides]);
  return { select: vi.fn(() => ({ from: (table: unknown) => {
    const result = Promise.resolve(data.get(table) ?? []);
    return Object.assign(result, { where: () => Object.assign(result, { limit: () => result }) });
  } })) } as unknown as AttentionDatabase;
}

describe("prepared collection snapshots", () => {
  it("prepares a bounded SELECT-only new collection and survives JSON serialization", async () => {
    const db = readOnlyDb();
    const plan = await loadCollectionEffectPlan(db, owner, candidate, "private");
    expect(plan.effects).toMatchObject({ targetContentId: null, targetDisposition: "new", resultingVisibility: "private", resultingDomainId: domainId, metadataJob: "schedule" });
    expect(parseCollectionEffectPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(Object.keys(db)).toEqual(["select"]);
  });
  it("reports actual reused visibility and domain rather than requested visibility", async () => {
    const db = readOnlyDb(new Map<unknown, unknown[]>([[contentIdentities, [identityRow]], [contents, [content]], [collections, [{ ...collection, visibility: "public", publicSince: date }]]]));
    const plan = await loadCollectionEffectPlan(db, owner, candidate, "private");
    expect(plan.effects).toMatchObject({ targetDisposition: "reused", resultingVisibility: "public", targetCollectionId: collectionId });
  });
  it("reports restoration without losing retained moderation", async () => {
    const db = readOnlyDb(new Map<unknown, unknown[]>([[contentIdentities, [identityRow]], [contents, [content]], [collections, [{ ...collection, collectionStatus: "deleted", moderationStatus: "blocked" }]]]));
    const plan = await loadCollectionEffectPlan(db, owner, candidate, "public");
    expect(plan.effects).toMatchObject({ targetDisposition: "restored", resultingVisibility: "public", resultingModeration: "blocked" });
  });
  it("reviews the persisted destination when an existing source identity resolves through an alias", async () => {
    const destination = "https://example.com/persisted-winner";
    const alias = { id: "00000000-0000-4000-8000-000000000007", aliasContentId: aliasId, primaryContentId: contentId,
      aliasDedupeKey: identity.dedupeKey, ruleVersion: "v1", reasonCode: "resolved_shortlink_identity", active: true, createdAt: date, disabledAt: null };
    const db = readOnlyDb(new Map<unknown, unknown[]>([[contentIdentities, [{ ...identityRow, contentId: aliasId }]],
      [contents, [{ ...content, outboundUrl: destination }]], [collections, [collection]], [contentAliases, [alias]]]));
    const plan = await loadCollectionEffectPlan(db, owner, candidate, "public");
    expect(plan.effects).toMatchObject({ targetContentId: contentId, sharedOutboundChange: false, resultingOutboundUrl: destination });
    const review = collectionReviewDetails({ kind: "collection", plan,
      attemptInput: { raw_input: candidate.selectedUrl, visibility: "public", idempotency_key: "alias-outbound-review" } });
    expect(review.details.find(row => row.label === "选择的原始链接")?.value).toBe(candidate.selectedUrl);
    expect(review.details.find(row => row.label === "收藏实际原文跳转链接")?.value).toBe(destination);
  });
  it("uses a new XHS destination only when the exact shared update path applies", async () => {
    const resolved = { ...candidate, identity: { ...identity, adapter: "xiaohongshu" as const },
      outboundUrl: "https://example.com/article?source=resolved" };
    const stored = { ...content, source: "xiaohongshu" };
    const data = (row: typeof stored) => readOnlyDb(new Map<unknown, unknown[]>([[contentIdentities, [identityRow]],
      [contents, [row]], [collections, [collection]]]));
    const matching = await loadCollectionEffectPlan(data(stored), owner, resolved, "public");
    expect(matching.effects).toMatchObject({ sharedOutboundChange: true, resultingOutboundUrl: resolved.outboundUrl });
    const aliased = await loadCollectionEffectPlan(data({ ...stored, normalizedUrl: "https://example.com/other-identity" }), owner, resolved, "public");
    expect(aliased.effects).toMatchObject({ sharedOutboundChange: false, resultingOutboundUrl: stored.outboundUrl });
  });
  it("discloses the shared alias edge that will be created, not only the owner's deleted collection", async () => {
    const other = identifyGenericWeb("https://example.com/old-identity")!;
    const resolved = { ...candidate, aliasIdentities: [other] };
    const db = readOnlyDb(new Map<unknown, unknown[]>([[contentIdentities, [identityRow, { ...identityRow,
      id: "00000000-0000-4000-8000-000000000007", contentId: aliasId, dedupeKey: other.dedupeKey, normalizedUrl: other.normalizedUrl }]],
      [contents, [content, { ...content, id: aliasId, normalizedUrl: other.normalizedUrl, outboundUrl: other.normalizedUrl }]], [collections, [collection]]]));
    const plan = await loadCollectionEffectPlan(db, owner, resolved, "public");
    const review = collectionReviewDetails({ kind: "collection", plan,
      attemptInput: { raw_input: resolved.selectedUrl, visibility: "public", idempotency_key: "shared-alias-review" } });
    expect(review.details.find(row => row.label === "已有内容别名关系")?.value).toBe("无");
    expect(review.details.find(row => row.label === "本次共享别名映射")?.value).toBe(`${aliasId} → ${contentId}: 新建共享映射`);
    expect(review.consequences.join(" ")).toContain("其他用户今后");
  });
  it("includes all merge deletions and alias mappings in the approval digest", async () => {
    const alias = { id: "00000000-0000-4000-8000-000000000007", aliasContentId: aliasId, primaryContentId: contentId, aliasDedupeKey: "alias-key", ruleVersion: "v1", reasonCode: "resolved_shortlink_identity", active: true, createdAt: date, disabledAt: null };
    const aliasCollection = { ...collection, id: "00000000-0000-4000-8000-000000000008", contentId: aliasId, visibility: "public", publicSince: date, moderationStatus: "blocked" };
    const db = readOnlyDb(new Map<unknown, unknown[]>([[contentIdentities, [identityRow]], [contents, [content]], [collections, [collection, aliasCollection]], [contentAliases, [alias]]]));
    const plan = await loadCollectionEffectPlan(db, owner, candidate, "private");
    expect(plan.effects.mergedCollectionIds).toEqual([aliasCollection.id]);
    expect(plan.effects.resultingVisibility).toBe("public");
    expect(plan.effects.resultingModeration).toBe("blocked");
    const changed = await loadCollectionEffectPlan(readOnlyDb(new Map<unknown, unknown[]>([[contentIdentities, [identityRow]], [contents, [content]], [collections, [collection]]])), owner, candidate, "private");
    expect(plan.digest).not.toBe(changed.digest);
  });
  it("rejects extra body/payload fields even with a recomputed digest", async () => {
    const plan = await loadCollectionEffectPlan(readOnlyDb(), owner, candidate, "private");
    const { digest: _digest, ...body } = plan;
    const malicious = { ...body, rawBody: "do not persist fetched content" };
    expect(() => parseCollectionEffectPlan({ ...malicious, digest: collectionPlanDigest(malicious) })).toThrow();
    expect(() => parseCollectionEffectPlan({ ...plan, candidate: { ...candidate, observedUrl: "x".repeat(25_000) } })).toThrow("collection_effect_plan_too_large");
  });
  it("rejects mutated reviewed effect fields", async () => {
    const plan = await loadCollectionEffectPlan(readOnlyDb(), owner, candidate, "private");
    expect(() => parseCollectionEffectPlan({ ...plan, effects: { ...plan.effects, resultingVisibility: "public" } })).toThrow("invalid_collection_effect_plan");
  });
  it("keeps pending bindings token-free and rejects tokens or unknown fields", () => {
    const binding = { attemptId: owner, pendingId: domainId, tokenHash: "a".repeat(64), vaultDigest: "b".repeat(64), visibility: "private", expiresAt: date, candidateId: contentId };
    expect(parsePendingCandidateBinding(binding)).toEqual(binding);
    expect(() => parsePendingCandidateBinding({ ...binding, selectionToken: "secret" })).toThrow();
  });
  it("resolves mixed text through the shared extractor without database access", async () => {
    const result = await resolveCollectionInput("Read https://example.com/article and https://example.com/second");
    expect(result.status).toBe("resolved");
    expect(result.candidates).toHaveLength(2);
  });
  it("rejects unsafe input and honors cancellation before source reads", async () => {
    expect(await resolveCollectionInput("http://127.0.0.1/secret")).toMatchObject({ status: "unsafe", candidates: [] });
    const controller = new AbortController(); controller.abort();
    await expect(resolveCollectionInput(candidate.selectedUrl, { signal: controller.signal })).rejects.toThrow();
    await expect(resolveCollectionInput(candidate.selectedUrl, { revalidate: async () => null })).rejects.toThrow("permission_revoked");
  });
  it("rejects changed database effects before any attempt or business writes", async () => {
    const plan = await loadCollectionEffectPlan(readOnlyDb(), owner, candidate, "private");
    const tx = Object.assign(readOnlyDb(new Map<unknown, unknown[]>([[domains, [{ id: aliasId, slug: "ai", active: true }]]])), { execute: vi.fn(async () => []) });
    await expect(establishPreparedCollection(tx as unknown as AttentionTransaction, { accountId: owner, isFilter: false, isMember: true }, { plan, attemptInput: { raw_input: candidate.selectedUrl, visibility: "private", idempotency_key: "snapshot-test-key" } })).rejects.toThrow("collection_effect_plan_changed");
    expect(Object.keys(tx).sort()).toEqual(["execute", "select"]);
  });
  it("rejects cross-owner prepared effects and root-only transaction authority", async () => {
    const plan = await loadCollectionEffectPlan(readOnlyDb(), owner, candidate, "private");
    const tx = Object.assign(readOnlyDb(), { execute: vi.fn(async () => []) });
    const rootRevalidate = vi.fn(async () => null);
    await expect(establishPreparedCollection(tx as unknown as AttentionTransaction, { accountId: aliasId, isFilter: false, isMember: true }, { plan, attemptInput: { raw_input: candidate.selectedUrl, visibility: "private", idempotency_key: "snapshot-test-key" } })).rejects.toThrow("permission_revoked");
    await expect(establishPreparedCollection(tx as unknown as AttentionTransaction, { accountId: owner, isFilter: false, isMember: true, revalidate: rootRevalidate }, { plan, attemptInput: { raw_input: candidate.selectedUrl, visibility: "private", idempotency_key: "snapshot-test-key" } })).rejects.toThrow("transaction_authority_required");
    expect(rootRevalidate).not.toHaveBeenCalled();
  });

});
