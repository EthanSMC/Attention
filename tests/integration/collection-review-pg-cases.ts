import { randomUUID } from "node:crypto";
import { identifyGenericWeb } from "@attention/collector";
import { accounts, collections, contentAliases, contents, entitlements, eq, filterProfiles, setAccountContext, sql, type DatabaseHandle } from "@attention/db";
import { expect, it } from "vitest";
import { establishPreparedCollection, loadCollectionEffectPlan, loadPendingCandidateForReview, parsePendingCandidateBinding, prepareSelectionFromResolved, type CollectionPrincipal, type ResolvedCandidate } from "../../apps/web/src/server/collection-service";
import { collectionReviewDetails } from "../../apps/web/src/server/website-agent-collection-review";

/** Register only inside the existing empty/marked/disposable PG17 guarded suite.
 * Uses its already initialized owner/runtime handles; never opens or migrates a DB.
 * External URLs below are identity fixtures only. No Fetcher or provider is called.
 */
export function registerCollectionReviewCoreCases(handles: () => { owner: DatabaseHandle; runtime: DatabaseHandle }): void {
  function candidate(label: string): ResolvedCandidate {
    const url = `https://example.test/${label}/${randomUUID()}`;
    const identity = identifyGenericWeb(url)!;
    return { identity, aliasIdentities: [], outboundUrl: identity.normalizedUrl, observedUrl: url, selectedUrl: url, redirectChain: [], displayHost: "example.test", resolutionStatus: "resolved" };
  }
  async function actor(): Promise<CollectionPrincipal> {
    const { owner } = handles(); const accountId = randomUUID();
    await owner.db.insert(accounts).values({ id: accountId, stableHandle: `effect-${accountId}`, displayName: "Synthetic effect reviewer" });
    await owner.db.insert(entitlements).values({ accountId, source: "admin_grant", memberEnabled: true });
    await owner.db.insert(filterProfiles).values({ accountId, displayName: "Synthetic effect Filter" });
    return { accountId, isFilter: true, isMember: true };
  }
  function request(c: ResolvedCandidate, visibility: "private" | "public" = "private") {
    return { raw_input: c.selectedUrl, idempotency_key: randomUUID(), visibility };
  }
  async function planFor(principal: CollectionPrincipal, c: ResolvedCandidate, visibility: "private" | "public" = "private") {
    return handles().runtime.db.transaction(async (tx) => {
      await setAccountContext(tx, principal.accountId);
      return loadCollectionEffectPlan(tx, principal.accountId, c, visibility);
    });
  }
  async function seed(principal: CollectionPrincipal, c: ResolvedCandidate, visibility: "private" | "public" = "private") {
    const plan = await planFor(principal, c, visibility);
    const result = await handles().runtime.db.transaction((tx) => establishPreparedCollection(tx, principal, { plan, attemptInput: request(c, visibility) }));
    expect(result).toHaveProperty("collection_id");
    if (!("collection_id" in result) || !("content_id" in result)) throw new Error("fixture_not_established");
    return { collectionId: result.collection_id, contentId: result.content_id };
  }

  it("Core exact plans reject one concurrent identity winner and leave no losing attempt, links, jobs or content", async () => {
    const { owner, runtime } = handles(); const principal = await actor(); const c = candidate("identity-race");
    const plan = await planFor(principal, c);
    const requests = [request(c), request(c)];
    const results = await Promise.allSettled(requests.map((attemptInput) => runtime.db.transaction((tx) => establishPreparedCollection(tx, principal, { plan, attemptInput }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const [counts] = await owner.sql`select
      (select count(*)::int from input_attempts where account_id=${principal.accountId}) as attempts,
      (select count(*)::int from contents where normalized_url=${c.identity.normalizedUrl}) as contents,
      (select count(*)::int from content_identities where dedupe_key=${c.identity.dedupeKey}) as identities,
      (select count(*)::int from collections where account_id=${principal.accountId}) as collections,
      (select count(*)::int from content_links where input_attempt_id in (select id from input_attempts where account_id=${principal.accountId})) as links,
      (select count(*)::int from jobs where payload->>'contentId' in (select id::text from contents where normalized_url=${c.identity.normalizedUrl})) as jobs`;
    expect(counts).toEqual({ attempts: 1, contents: 1, identities: 1, collections: 1, links: 1, jobs: 1 });
  });

  it("Core reports and applies public alias merge including every deletion and retained moderation", async () => {
    const { owner, runtime } = handles(); const principal = await actor();
    const canonical = candidate("merge-primary"); const original = candidate("merge-alias");
    const primary = await seed(principal, canonical); const alias = await seed(principal, original, "public");
    await owner.db.update(collections).set({ moderationStatus: "blocked" }).where(eq(collections.id, alias.collectionId));
    const resolved = { ...canonical, aliasIdentities: [original.identity], selectedUrl: original.selectedUrl, redirectChain: [canonical.selectedUrl] };
    const plan = await planFor(principal, resolved);
    expect(plan.effects).toMatchObject({ targetContentId: primary.contentId, targetCollectionId: primary.collectionId, resultingVisibility: "public", resultingModeration: "blocked", mergedCollectionIds: [alias.collectionId] });
    const result = await runtime.db.transaction((tx) => establishPreparedCollection(tx, { ...principal, privateCollectionOnly: true }, { plan, attemptInput: request(resolved) }));
    expect(result).toMatchObject({ collection_id: primary.collectionId, current_visibility: "public", status: "merged_with_existing_content" });
    const [actual] = await owner.db.select().from(collections).where(eq(collections.id, primary.collectionId));
    const [removed] = await owner.db.select().from(collections).where(eq(collections.id, alias.collectionId));
    expect(actual).toMatchObject({ visibility: "public", moderationStatus: "blocked", collectionStatus: "active" });
    expect(removed).toMatchObject({ collectionStatus: "deleted" });
  });

  it("Core invalidates an absent-alias snapshot when a different alias mapping appears before approval", async () => {
    const { owner, runtime } = handles(); const principal = await actor();
    const canonical = candidate("alias-drift-primary"); const original = candidate("alias-drift-source"); const alternative = candidate("alias-drift-other");
    const primary = await seed(principal, canonical); const alias = await seed(principal, original); const other = await seed(principal, alternative);
    const resolved = { ...canonical, aliasIdentities: [original.identity], selectedUrl: original.selectedUrl };
    const plan = await planFor(principal, resolved);
    await owner.db.insert(contentAliases).values({ aliasContentId: alias.contentId, primaryContentId: other.contentId, aliasDedupeKey: original.identity.dedupeKey, ruleVersion: "v1", reasonCode: "resolved_shortlink_identity" });
    const attemptInput = request(resolved);
    await expect(runtime.db.transaction((tx) => establishPreparedCollection(tx, principal, { plan, attemptInput }))).rejects.toMatchObject({ code: "collection_effect_plan_changed" });
    const [count] = await owner.sql`select count(*)::int as count from input_attempts where account_id=${principal.accountId} and channel_message_id=${attemptInput.idempotency_key}`;
    expect(count?.count).toBe(0);
    const [target] = await owner.db.select().from(collections).where(eq(collections.id, primary.collectionId));
    const [unchanged] = await owner.db.select().from(collections).where(eq(collections.id, alias.collectionId));
    expect(target?.visibility).toBe("private"); expect(unchanged?.collectionStatus).toBe("active");
  });

  it("Core and the exact review retain the real persisted destination of an aliased source", async () => {
    const { owner, runtime } = handles(); const principal = await actor();
    const original = candidate("aliased-original"), canonical = candidate("aliased-winner");
    const alias = await seed(principal, original), primary = await seed(principal, canonical);
    await owner.db.insert(contentAliases).values({ aliasContentId: alias.contentId, primaryContentId: primary.contentId,
      aliasDedupeKey: original.identity.dedupeKey, ruleVersion: "v1", reasonCode: "resolved_shortlink_identity" });
    const persistedUrl = `https://example.test/persisted-destination/${randomUUID()}`;
    await owner.db.update(contents).set({ outboundUrl: persistedUrl }).where(eq(contents.id, primary.contentId));
    const plan = await planFor(principal, original, "public");
    const attemptInput = request(original, "public");
    const review = collectionReviewDetails({ kind: "collection", plan, attemptInput });
    expect(plan.effects).toMatchObject({ targetContentId: primary.contentId, resultingOutboundUrl: persistedUrl, sharedOutboundChange: false });
    expect(review.details.find(row => row.label === "收藏实际原文跳转链接")?.value).toBe(persistedUrl);
    const result = await runtime.db.transaction(tx => establishPreparedCollection(tx, principal, { plan, attemptInput }));
    expect(result).toMatchObject({ content_id: primary.contentId, collection_id: primary.collectionId });
    const [stored] = await owner.db.select({ outboundUrl: contents.outboundUrl }).from(contents).where(eq(contents.id, primary.contentId));
    expect(stored?.outboundUrl).toBe(plan.effects.resultingOutboundUrl);
  });

  it("Core rolls pending token consumption back with content, events, links and jobs, then permits exactly one retry", async () => {
    const { owner, runtime } = handles(); const principal = await actor(); const a = candidate("pending-a"), b = candidate("pending-b");
    const response = await prepareSelectionFromResolved(runtime.db, principal, { raw_input: `${a.selectedUrl} ${b.selectedUrl}`, idempotency_key: randomUUID(), visibility: "private" }, { status: "resolved", candidates: [a, b] });
    expect(response.status).toBe("ambiguous");
    const options = await loadPendingCandidateForReview(runtime.db, principal.accountId, { attemptId: response.attempt_id });
    const selected = options.candidates.find((c) => c.dedupeKey === a.identity.dedupeKey)!;
    const pending = parsePendingCandidateBinding({ attemptId: options.attemptId, pendingId: options.pendingId, tokenHash: options.tokenHash, vaultDigest: options.vaultDigest, expiresAt: options.expiresAt, visibility: options.visibility, candidateId: selected.candidateId });
    const plan = await planFor(principal, a);
    await expect(runtime.db.transaction(async (tx) => {
      const established = await establishPreparedCollection(tx, principal, { plan, pending });
      expect(established).toHaveProperty("collection_id");
      throw new Error("synthetic_approval_commit_failure");
    })).rejects.toThrow("synthetic_approval_commit_failure");
    const [rolledBack] = await owner.sql`select p.consumed_at, p.encrypted_payload, a.selection_consumed_at, a.status,
      (select count(*)::int from content_links where input_attempt_id=a.id) as links,
      (select count(*)::int from collections where account_id=a.account_id) as collections,
      (select count(*)::int from contents where normalized_url=${a.identity.normalizedUrl}) as contents
      from pending_candidate_sets p join input_attempts a on a.id=p.input_attempt_id where p.id=${pending.pendingId}`;
    expect(rolledBack).toMatchObject({ consumed_at: null, selection_consumed_at: null, status: "ambiguous", links: 0, collections: 0, contents: 0 });
    expect(String(rolledBack?.encrypted_payload).length).toBeGreaterThan(0);
    await runtime.db.transaction((tx) => establishPreparedCollection(tx, principal, { plan, pending }));
    await expect(loadPendingCandidateForReview(runtime.db, principal.accountId, { attemptId: pending.attemptId, candidateId: pending.candidateId! })).rejects.toMatchObject({ code: "selection_expired" });
    const [consumed] = await owner.sql`select consumed_at, encrypted_payload from pending_candidate_sets where id=${pending.pendingId}`;
    expect(consumed?.consumed_at).not.toBeNull(); expect(consumed?.encrypted_payload).toBe("");
  });

  it("Core stale owner collections and restored/public state never silently inherit an earlier review", async () => {
    const { owner, runtime } = handles(); const principal = await actor(); const c = candidate("collection-state-drift");
    const seeded = await seed(principal, c);
    const plan = await planFor(principal, c);
    await owner.db.update(collections).set({ collectionStatus: "deleted" }).where(eq(collections.id, seeded.collectionId));
    await expect(runtime.db.transaction((tx) => establishPreparedCollection(tx, principal, { plan, attemptInput: request(c) }))).rejects.toMatchObject({ code: "collection_effect_plan_changed" });
    const [deleted] = await owner.db.select().from(collections).where(eq(collections.id, seeded.collectionId)); expect(deleted?.collectionStatus).toBe("deleted");
    const restoredPlan = await planFor(principal, c, "public");
    expect(restoredPlan.effects.targetDisposition).toBe("restored");
    const result = await runtime.db.transaction((tx) => establishPreparedCollection(tx, principal, { plan: restoredPlan, attemptInput: request(c, "public") }));
    expect(result).toMatchObject({ current_visibility: "public", collection_id: seeded.collectionId });
  });
  it("Core rejects a pending token that expires after effects but before returning from the transaction", async () => {
    const { owner, runtime } = handles(); const principal = await actor(); const a = candidate("expiry-a"), b = candidate("expiry-b");
    const response = await prepareSelectionFromResolved(runtime.db, principal, { raw_input: `${a.selectedUrl} ${b.selectedUrl}`, idempotency_key: randomUUID(), visibility: "private" }, { status: "resolved", candidates: [a, b] });
    const plan = await planFor(principal, a);
    await owner.sql`update pending_candidate_sets set expires_at=clock_timestamp()+interval '3 seconds' where input_attempt_id=${response.attempt_id}`;
    const pending = await loadPendingCandidateForReview(runtime.db, principal.accountId, { attemptId: response.attempt_id });
    const selected = pending.candidates.find((c) => c.dedupeKey === a.identity.dedupeKey)!;
    const binding = parsePendingCandidateBinding({ attemptId: pending.attemptId, pendingId: pending.pendingId, tokenHash: pending.tokenHash, vaultDigest: pending.vaultDigest, expiresAt: pending.expiresAt, visibility: pending.visibility, candidateId: selected.candidateId });
    let validations = 0;
    await expect(runtime.db.transaction((tx) => establishPreparedCollection(tx, { ...principal, revalidateInTransaction: async (authTx) => {
      validations += 1;
      if (validations === 2) await authTx.execute(sql`select pg_sleep(3.1)`);
      return { ...principal, scopes: ["collection:write"] };
    } }, { plan, pending: binding }))).rejects.toMatchObject({ code: "selection_expired" });
    expect(validations).toBe(2);
    const [state] = await owner.sql`select consumed_at, encrypted_payload,
      (select count(*)::int from collections where account_id=${principal.accountId}) as collections,
      (select count(*)::int from contents where normalized_url=${a.identity.normalizedUrl}) as contents
      from pending_candidate_sets where id=${binding.pendingId}`;
    expect(state).toMatchObject({ consumed_at: null, collections: 0, contents: 0 });
    expect(String(state?.encrypted_payload).length).toBeGreaterThan(0);
  }, 15_000);

}
