import { createHash } from "node:crypto";
import type { ContentEnrichmentSnapshot } from "../server/content-enrichment-plan";
import { parsePreparedEnrichment } from "../server/website-agent-enrichment-review";
import { buildContentEnrichmentPlan, enrichmentHash } from "../server/content-enrichment-plan";
import { websiteSourceAttemptRef, type WebsiteSourceAttestation, type WebsiteEnrichmentRunIdentity } from "../server/website-agent-source-evidence";
import type { CollectionStatusResult } from "../server/collection-status-service";
export const ids = { account: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", auth: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  session: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", run: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  content: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", collection: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  winner: "11111111-1111-4111-8111-111111111111", winnerCollection: "22222222-2222-4222-8222-222222222222",
  domain: "33333333-3333-4333-8333-333333333333", identity: "44444444-4444-4444-8444-444444444444" };
export const time = "2026-11-10T12:00:00.000Z";
export const url = "https://example.org/owned", finalUrl = "https://example.org/final";
export const runIdentity: WebsiteEnrichmentRunIdentity = { accountId: ids.account, authSessionId: ids.auth,
  sessionId: ids.session, originRunId: ids.run, originRevision: 4 };
export const enrichmentInput = { content_id: ids.content, idempotency_key: "enrichment-fixture", title: "An accurate title",
  summary: "A grounded shared summary.", tags: ["Agents"], resolved_url: finalUrl };
export function snapshot(): ContentEnrichmentSnapshot {
  const content: ContentEnrichmentSnapshot["owned"] = { id: ids.content, updatedAt: time, title: null, outboundUrl: url,
    normalizedUrl: url, source: "generic_web", contentStatus: "active", publicSafetyStatus: "allowed",
    communityModerationStatus: "clear", takedownStatus: "none", summaryStatus: "pending", summaryHash: enrichmentHash("fixture", null),
    firstPublicAt: null, visibilityVersion: 0 };
  const collection: ContentEnrichmentSnapshot["ownedCollection"] = { id: ids.collection, accountId: ids.account,
    contentId: ids.content, domainId: ids.domain, collectionStatus: "active", visibility: "private", moderationStatus: "clear",
    sourceChannel: "web", collectedAt: time, updatedAt: time, publicSince: null, filterRevokedAt: null };
  return { accountId: ids.account, owned: content, winner: { ...content }, ownedCollection: collection,
    winnerCollection: { ...collection }, identity: null, relationshipsHash: enrichmentHash("fixture", []),
    attemptsHash: enrichmentHash("fixture", []), affectedAttemptCount: 0, aliasRelation: "none", winnerHasParent: false,
    ownedHasChildren: false, ownedHasActiveIdentity: true, accountActive: true, filterActive: false, domainActive: true };
}
export function mergeSnapshot(): ContentEnrichmentSnapshot {
  const value = snapshot();
  value.winner = { ...value.owned, id: ids.winner, outboundUrl: finalUrl, normalizedUrl: finalUrl };
  value.winnerCollection = { ...value.ownedCollection, id: ids.winnerCollection, contentId: ids.winner };
  value.identity = { id: ids.identity, contentId: ids.winner, active: true, dedupeKey: `generic_web:v1:url:${finalUrl}` };
  return value;
}
export function attestation(): WebsiteSourceAttestation {
  return { ...runIdentity, version: 1, readerPolicyVersion: "owned-article-v1", collectionId: ids.collection, contentId: ids.content,
    operation: createHash("sha256").update(JSON.stringify([ids.collection, time, ids.content, time, "generic_web", url])).digest("hex"),
    sourceFingerprint: createHash("sha256").update(url).digest("hex"), sourceUrl: url, finalPublicUrl: finalUrl,
    extractionMethod: "readability", truncated: false, readAt: time, observedAt: time, expiresAt: "2026-11-10T12:02:00.000Z",
    textDigest: createHash("sha256").update("Synthetic source text.").digest("hex"), requestRef: `website-evidence:${ids.run}`,
    attemptRef: websiteSourceAttemptRef(runIdentity, ids.collection) };
}
export function status(): CollectionStatusResult {
  return { attempt: null, collection: { collection_id: ids.collection, collection_status: "active", moderation_status: "clear",
    updated_at: time, collected_at: time, effectively_public: false, filter_revoked_at: null, original_url: `/out/mine/${ids.collection}`,
    public_since: null, visibility: "private" }, content: { content_id: ids.content, updated_at: time, source: "generic_web",
    enrichment_action: "generate_summary", public_read_url: url, summary_status: "pending", title: null, community_moderation_status: "clear",
    content_status: "active", content_type: "article", enrichment_status: "pending", public_safety_status: "allowed", takedown_status: "none" } };
}

/** Synthetic strict artifact for policy/store/HTTP tests; never an authority source. */
export function preparedFixture(target = snapshot()) {
  const plan = buildContentEnrichmentPlan(enrichmentInput, target), evidence = attestation();
  return parsePreparedEnrichment({ kind: "enrichment", version: 1, plan, evidence, expiresAt: evidence.expiresAt,
    bindingHash: enrichmentHash("evidence-binding", { planFingerprint: plan.fingerprint, input: plan.input, evidence }) });
}
