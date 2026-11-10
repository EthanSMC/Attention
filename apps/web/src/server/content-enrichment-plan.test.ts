import { describe, expect, it } from "vitest";
import { buildContentEnrichmentPlan, parseContentEnrichmentPlan } from "./content-enrichment-plan";
import { enrichmentInput, mergeSnapshot, snapshot, ids } from "../test-support/enrichment-review-fixtures";

describe("strict no-write enrichment effect planning", () => {
  it("normalizes exactly the shared Core title and tag semantics", () => {
    const plan = buildContentEnrichmentPlan({ ...enrichmentInput, title: "  One\n title  ", tags: ["Agents", " agents ", "MCP"] }, snapshot());
    expect(plan.input).toMatchObject({ title: "One title", tags: ["Agents", "MCP"] });
    expect(plan.effects).toMatchObject({ claimIdentity: true, linkAlias: false, writeSharedSummary: true,
      softDeleteCollectionId: null, notification: { mode: "none" } });
    expect(parseContentEnrichmentPlan(plan)).toEqual(plan);
  });
  it("does not confuse already-enriched with an effect-free merge", () => {
    const target = mergeSnapshot(); target.winner.summaryStatus = "ready";
    const plan = buildContentEnrichmentPlan(enrichmentInput, target);
    expect(plan.effects).toMatchObject({ writeSharedSummary: false, linkAlias: true,
      softDeleteCollectionId: ids.collection, notification: { mode: "none" } });
  });
  it("binds deleted winner restoration, public inheritance and WeChat source promotion", () => {
    const target = mergeSnapshot(); target.winnerCollection!.collectionStatus = "deleted";
    target.ownedCollection.sourceChannel = "wechat"; target.ownedCollection.visibility = "public";
    target.ownedCollection.publicSince = target.ownedCollection.collectedAt; target.filterActive = true;
    const plan = buildContentEnrichmentPlan(enrichmentInput, target);
    expect(plan.effects).toMatchObject({ restoreWinnerCollection: true, promoteSourceChannel: true,
      resultingVisibility: "public", effectivelyPublic: true, resultingSourceChannel: "wechat",
      notification: { mode: "queue_if_missing", audience: "existing_eligible_wechat_collectors" } });
  });
  it("preserves the source publication revocation when creating a merge winner collection", () => {
    const target = mergeSnapshot(); target.winnerCollection = null;
    target.ownedCollection.visibility = "public"; target.filterActive = true;
    target.ownedCollection.filterRevokedAt = target.ownedCollection.updatedAt;
    expect(buildContentEnrichmentPlan(enrichmentInput, target).effects).toMatchObject({ createWinnerCollection: true,
      resultingVisibility: "public", resultingFilterRevokedAt: target.ownedCollection.updatedAt, effectivelyPublic: false });
  });
  it.each(["summaryHash", "updatedAt", "outboundUrl"] as const)("binds current target %s", field => {
    const before = snapshot(), after = snapshot();
    if (field === "summaryHash") after.owned[field] = "f".repeat(64);
    if (field === "updatedAt") after.owned[field] = "2026-11-10T12:00:01.000Z";
    if (field === "outboundUrl") after.owned[field] = "https://example.org/changed";
    after.winner = { ...after.owned };
    expect(buildContentEnrichmentPlan(enrichmentInput, before).fingerprint).not.toBe(buildContentEnrichmentPlan(enrichmentInput, after).fingerprint);
  });
  it("rejects source ownership, identity winner and alias-cycle inconsistencies", () => {
    const wrongOwner = snapshot(); wrongOwner.ownedCollection.accountId = ids.auth;
    expect(() => buildContentEnrichmentPlan(enrichmentInput, wrongOwner)).toThrow("enrichment_target_unavailable");
    const wrongWinner = mergeSnapshot(); wrongWinner.identity!.contentId = ids.content;
    expect(() => buildContentEnrichmentPlan(enrichmentInput, wrongWinner)).toThrow("enrichment_target_unavailable");
    const cycle = mergeSnapshot(); cycle.winnerHasParent = true;
    expect(() => buildContentEnrichmentPlan(enrichmentInput, cycle)).toThrow("enrichment_target_unavailable");
  });
  it("rejects stale fingerprints, replacement effects and raw body persistence", () => {
    const plan = buildContentEnrichmentPlan(enrichmentInput, snapshot());
    expect(() => parseContentEnrichmentPlan({ ...plan, fingerprint: "f".repeat(64) })).toThrow("enrichment_plan_invalid");
    expect(() => parseContentEnrichmentPlan({ ...plan, effects: { ...plan.effects, effectivelyPublic: true } })).toThrow("enrichment_plan_invalid");
    expect(() => parseContentEnrichmentPlan({ ...plan, temporary_text: "raw source" })).toThrow("enrichment_plan_invalid");
  });
});
