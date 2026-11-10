import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionTransaction } from "@attention/db";
import type { AttentionToolContext } from "./attention-tool-registry";
import type * as EnrichmentServiceModule from "./content-enrichment-service";
import { buildContentEnrichmentPlan } from "./content-enrichment-plan";
import { parsePreparedEnrichment, prepareWebsiteEnrichment, preflightWebsiteEnrichment, websiteEnrichmentCoreOverrides } from "./website-agent-enrichment-review";
import { attestation, enrichmentInput, ids, mergeSnapshot, runIdentity, snapshot, status, time } from "../test-support/enrichment-review-fixtures";
const mocks = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("./content-enrichment-service", async importOriginal => ({ ...await importOriginal<typeof EnrichmentServiceModule>(), applyPreparedContentEnrichment: mocks.apply }));
const tx = {} as AttentionTransaction;
function context(): AttentionToolContext {
  return { accountId: ids.account, caller: { credentialId: ids.auth, credentialKind: "session", entrypoint: "hosted_agent", clientId: "website" },
    isMember: true, isFilter: false, scopes: ["collection:write", "collection:read"], requestId: ids.run, runId: `website:${ids.run}`,
    serviceOrigin: "https://attention.example", getDatabase: () => tx, signal: new AbortController().signal };
}
function fixture(merge = false) {
  const target = merge ? mergeSnapshot() : snapshot();
  const evidenceRun = { identity: runIdentity, readCollectionSource: vi.fn(), evidenceFor: vi.fn(() => attestation()) };
  const deps = { now: () => new Date(time), getStatus: vi.fn(async () => status()),
    loadPlan: vi.fn(async () => buildContentEnrichmentPlan(enrichmentInput, target)) };
  return { target, evidenceRun, deps };
}
describe("exact enrichment review integration boundary", () => {
  beforeEach(() => mocks.apply.mockReset());
  it("binds exact normalized text and source without persisting the article body", async () => {
    const { evidenceRun, deps } = fixture();
    const { prepared, review } = await prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps);
    expect(parsePreparedEnrichment(prepared)).toEqual(prepared);
    expect(prepared.expiresAt).toBe(attestation().expiresAt);
    expect(review.details).toContainEqual({ label: "拟提交摘要", value: enrichmentInput.summary });
    expect(JSON.stringify(prepared)).not.toContain("temporary_text");
    expect(JSON.stringify(prepared)).not.toContain("Synthetic source text.");
    expect(JSON.stringify(review)).toContain("共享");
    expect(JSON.stringify(review)).toContain("建立最终链接");
    expect(JSON.stringify(review)).toContain("不迁移历史提交");
  });
  it("rejects replacement final URL, missing source, stale operation and mismatched session", async () => {
    const { evidenceRun, deps } = fixture();
    await expect(prepareWebsiteEnrichment(context(), { ...enrichmentInput, resolved_url: "https://example.org/other" }, evidenceRun, deps)).rejects.toThrow("enrichment_source_changed");
    deps.getStatus.mockImplementation(async () => { const current = status(); current.content!.updated_at = "2026-11-10T12:00:01.000Z"; return current; });
    await expect(prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps)).rejects.toThrow("enrichment_source_changed");
    const wrong = context(); wrong.caller.credentialId = ids.run;
    await expect(prepareWebsiteEnrichment(wrong, enrichmentInput, evidenceRun, deps)).rejects.toThrow("enrichment_permission_revoked");
    expect(deps.loadPlan).not.toHaveBeenCalled();
  });
  it("catches a source revision race between source status and plan loading", async () => {
    const { evidenceRun, deps, target } = fixture(); target.owned.updatedAt = "2026-11-10T12:00:01.000Z";
    target.winner.updatedAt = target.owned.updatedAt;
    await expect(prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps)).rejects.toThrow("enrichment_review_invalid");
  });
  it("displays already-enriched merge effects rather than promising a new summary", async () => {
    const { evidenceRun, deps, target } = fixture(true); target.winner.summaryStatus = "ready";
    target.winnerCollection!.collectionStatus = "deleted"; target.ownedCollection.sourceChannel = "wechat"; target.affectedAttemptCount = 3;
    const { review, prepared } = await prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps);
    expect(JSON.stringify(review)).toContain("3 条关联历史提交");
    expect(review.title).toContain("沿用已有"); expect(JSON.stringify(review)).toContain("恢复已删除");
    expect(JSON.stringify(review)).toContain("上方拟提交文本不会写入");
    expect(prepared.plan.effects).toMatchObject({ restoreWinnerCollection: true, promoteSourceChannel: true,
      softDeleteCollectionId: ids.collection, writeSharedSummary: false, notification: { mode: "none" } });
  });
  it("displays conditional existing-WeChat-collector notification and source promotion", async () => {
    const { evidenceRun, deps, target } = fixture(true); target.ownedCollection.sourceChannel = "wechat";
    const { review } = await prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps);
    expect(JSON.stringify(review)).toContain("仅在缺少去重事件时"); expect(JSON.stringify(review)).toContain("已有且符合条件");
    expect(JSON.stringify(review)).toContain("不保证实际投递"); expect(JSON.stringify(review)).toContain("不复制凭据或绑定");
  });
  it("rejects changed prepared args, body fields, expiry extension and origin identity", async () => {
    const { evidenceRun, deps } = fixture();
    const { prepared } = await prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps);
    expect(() => parsePreparedEnrichment({ ...prepared, plan: { ...prepared.plan, input: { ...enrichmentInput, summary: "Replacement" } } })).toThrow("enrichment_review_invalid");
    expect(() => parsePreparedEnrichment({ ...prepared, evidence: { ...prepared.evidence, temporary_text: "Raw article" } })).toThrow("enrichment_review_invalid");
    expect(() => parsePreparedEnrichment({ ...prepared, expiresAt: "2026-11-10T12:04:00.000Z" })).toThrow("enrichment_review_invalid");
    expect(() => preflightWebsiteEnrichment(prepared, { ...runIdentity, originRunId: ids.auth }, new Date(time))).toThrow("source_evidence_changed");
  });
  it("runs only exact stored arguments on the supplied canonical invocation savepoint", async () => {
    const { evidenceRun, deps } = fixture(); const { prepared } = await prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps);
    mocks.apply.mockResolvedValue({ contentId: ids.content, status: "enriched", summaryStatus: "ready" });
    const core = websiteEnrichmentCoreOverrides(tx, prepared, runIdentity, deps.now);
    await expect(core.submitContentEnrichment({} as AttentionTransaction, { accountId: ids.account }, enrichmentInput)).rejects.toThrow("enrichment_review_invalid");
    await expect(core.submitContentEnrichment(tx, { accountId: ids.account }, { ...enrichmentInput, summary: "Changed" })).rejects.toThrow("enrichment_review_invalid");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(await core.submitContentEnrichment(tx, { accountId: ids.account }, enrichmentInput)).toMatchObject({ status: "enriched" });
    expect(mocks.apply).toHaveBeenCalledWith(tx, { accountId: ids.account }, prepared.plan);
  });
  it("throws after an effect if evidence expired, so the outer savepoint cannot commit it", async () => {
    const { evidenceRun, deps } = fixture(); const { prepared } = await prepareWebsiteEnrichment(context(), enrichmentInput, evidenceRun, deps);
    let now = new Date(time);
    mocks.apply.mockImplementation(async () => { now = new Date(prepared.expiresAt); return { contentId: ids.content, status: "enriched", summaryStatus: "ready" }; });
    const core = websiteEnrichmentCoreOverrides(tx, prepared, runIdentity, () => now);
    await expect(core.submitContentEnrichment(tx, { accountId: ids.account }, enrichmentInput)).rejects.toThrow("source_evidence_expired");
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
});
