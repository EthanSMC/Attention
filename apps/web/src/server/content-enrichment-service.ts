import "server-only";

import {
  CHANNEL_SUMMARY_READY_EVENT_TYPE,
  summaryReadyNotificationDedupeKey,
} from "@attention/contracts";
import {
  and,
  collectionEvents,
  collections,
  accounts,
  domains,
  filterProfiles,
  contentIdentities,
  contents,
  eq,
  eventLedger,
  inputAttempts,
  sql,
  setAccountContext,
  type AttentionTransaction,
  type AttentionDatabase,
} from "@attention/db";

export { submitContentEnrichmentInputSchema, ContentEnrichmentServiceError } from "./content-enrichment-model";
export type { ContentEnrichmentPrincipal, SubmitContentEnrichmentInput, SubmitContentEnrichmentResult, ContentEnrichmentServiceErrorCode } from "./content-enrichment-model";
import { ContentEnrichmentServiceError, assertEnrichmentEligible, normalizeContentEnrichmentInput, enrichmentResolvedIdentity,
  type ContentEnrichmentPrincipal, type SubmitContentEnrichmentInput, type SubmitContentEnrichmentResult, type OwnedEnrichmentTarget } from "./content-enrichment-model";

import { ContentEnrichmentPlanError, lockAndRevalidateContentEnrichmentPlan, type ContentEnrichmentPlan } from "./content-enrichment-plan";

async function resolveEnrichmentTarget(
  tx: AttentionTransaction,
  principal: ContentEnrichmentPrincipal,
  owned: OwnedEnrichmentTarget,
  resolvedUrl: string,
  reviewed?: ContentEnrichmentPlan,
): Promise<OwnedEnrichmentTarget> {
  const identity = enrichmentResolvedIdentity(resolvedUrl);
  if (!identity) {
    throw new ContentEnrichmentServiceError(
      "content_enrichment_invalid_link",
      422,
    );
  }

  const [claimed] = await tx
    .insert(contentIdentities)
    .values({
      adapterVersion: identity.adapterVersion,
      contentId: owned.id,
      dedupeKey: identity.dedupeKey,
      identityKind: "normalized",
      normalizedUrl: identity.normalizedUrl,
      sourceAdapter: identity.adapter,
    })
    .onConflictDoNothing({ target: contentIdentities.dedupeKey })
    .returning({ contentId: contentIdentities.contentId });
  const primaryContentId = claimed?.contentId ?? (
    await tx
      .select({ contentId: contentIdentities.contentId })
      .from(contentIdentities)
      .where(
        and(
          eq(contentIdentities.dedupeKey, identity.dedupeKey),
          eq(contentIdentities.active, true),
        ),
      )
      .for("update")
      .limit(1)
  )[0]?.contentId;
  if (!primaryContentId) {
    throw new Error("resolved_identity_conflict_without_winner");
  }
  if (reviewed && (primaryContentId !== reviewed.effects.winnerContentId || Boolean(claimed) !== reviewed.effects.claimIdentity))
    throw new ContentEnrichmentPlanError("enrichment_target_changed");
  if (primaryContentId === owned.id) return owned;

  const [primary] = await tx
    .select({
      communityModerationStatus: contents.communityModerationStatus,
      contentStatus: contents.contentStatus,
      id: contents.id,
      publicSafetyStatus: contents.publicSafetyStatus,
      summaryStatus: contents.summaryStatus,
      takedownStatus: contents.takedownStatus,
    })
    .from(contents)
    .where(eq(contents.id, primaryContentId))
    .for("update")
    .limit(1);
  if (!primary) throw new Error("resolved_identity_points_to_missing_content");

  const [primaryCollection] = await tx
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.accountId, principal.accountId),
        eq(collections.contentId, primary.id),
      ),
    )
    .for("update")
    .limit(1);
  const [currentCollection] = await tx
    .select()
    .from(collections)
    .where(eq(collections.id, owned.collectionId))
    .for("update")
    .limit(1);
  if (!currentCollection) {
    throw new ContentEnrichmentServiceError("content_not_found", 404);
  }

  const now = new Date();
  let targetCollection = primaryCollection;
  if (!targetCollection) {
    const [createdPrimaryCollection] = await tx
      .insert(collections)
      .values({
        accountId: principal.accountId,
        collectedAt: currentCollection.collectedAt,
        collectionStatus: "active",
        contentId: primary.id,
        domainId: currentCollection.domainId,
        filterRevokedAt: currentCollection.filterRevokedAt,
        moderationStatus: currentCollection.moderationStatus,
        publicSince: currentCollection.publicSince,
        sourceChannel: currentCollection.sourceChannel,
        visibility: currentCollection.visibility,
      })
      .onConflictDoNothing({ target: [collections.accountId, collections.contentId] })
      .returning();
    if (reviewed && (!reviewed.effects.createWinnerCollection || !createdPrimaryCollection))
      throw new ContentEnrichmentPlanError("enrichment_target_changed");
    targetCollection = createdPrimaryCollection ?? (
      await tx
        .select()
        .from(collections)
        .where(
          and(
            eq(collections.accountId, principal.accountId),
            eq(collections.contentId, primary.id),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
  }
  if (!targetCollection) throw new Error("primary_collection_create_failed");
  if (reviewed && (reviewed.effects.winnerCollectionId !== null && targetCollection.id !== reviewed.effects.winnerCollectionId))
    throw new ContentEnrichmentPlanError("enrichment_target_changed");
  if (reviewed?.effects.restoreWinnerCollection) {
    // Reviewed-only ordering fix: the alias function requires both collections
    // active. Restore only the exact approved winner, inside this savepoint.
    const [restored] = await tx.update(collections).set({ collectionStatus: "active", updatedAt: now })
      .where(and(eq(collections.id, targetCollection.id), eq(collections.accountId, principal.accountId),
        eq(collections.collectionStatus, "deleted"))).returning();
    if (!restored) throw new ContentEnrichmentPlanError("enrichment_target_changed");
    targetCollection = restored;
  }

  if (reviewed?.effects.promoteSourceChannel) {
    // Preserve the already-owned WeChat source during this reviewed merge.
    // This copies no credentials or channel binding and creates no connection.
    const [promoted] = await tx.update(collections).set({ sourceChannel: "wechat", updatedAt: now })
      .where(and(eq(collections.id, targetCollection.id), eq(collections.accountId, principal.accountId),
        eq(collections.sourceChannel, "web"), eq(collections.collectionStatus, "active"))).returning();
    if (!promoted) throw new ContentEnrichmentPlanError("enrichment_target_changed");
    targetCollection = promoted;
  }

  await tx.execute(sql`
    select public.attention_link_owned_content_alias(
      ${owned.id}::uuid,
      ${primary.id}::uuid,
      'agent_resolved_identity'
    )
  `);

  if (targetCollection.id !== currentCollection.id) {
    const visibility =
      targetCollection.visibility === "public" ||
      currentCollection.visibility === "public"
        ? "public"
        : "private";
    const publicSince = visibility === "public"
      ? [targetCollection.publicSince, currentCollection.publicSince]
          .filter((value): value is Date => value !== null)
          .sort((left, right) => left.getTime() - right.getTime())[0] ?? now
      : null;
    await tx
      .update(collections)
      .set({
        collectionStatus: "active",
        collectedAt:
          targetCollection.collectedAt < currentCollection.collectedAt
            ? targetCollection.collectedAt
            : currentCollection.collectedAt,
        moderationStatus:
          targetCollection.moderationStatus === "blocked" ||
          currentCollection.moderationStatus === "blocked"
            ? "blocked"
            : "clear",
        publicSince,
        updatedAt: now,
        visibility,
      })
      .where(eq(collections.id, targetCollection.id));
    const [deletedCollection] = await tx
      .update(collections)
      .set({ collectionStatus: "deleted", updatedAt: now })
      .where(eq(collections.id, currentCollection.id))
      .returning();
    if (!deletedCollection) throw new Error("collection_alias_delete_failed");
    await tx.insert(collectionEvents).values({
      accountId: principal.accountId,
      actorAccountId: principal.accountId,
      collectionId: deletedCollection.id,
      contentId: deletedCollection.contentId,
      eventType: "merged_with_existing_content",
      nextState: {
        collectionStatus: "deleted",
        mergedIntoCollectionId: targetCollection.id,
      },
      occurredAt: now,
      previousState: {
        collectionStatus: currentCollection.collectionStatus,
        visibility: currentCollection.visibility,
      },
    });
  }
  const targetCollectionId = targetCollection.id;

  const targetIsPublic =
    targetCollection.visibility === "public" ||
    currentCollection.visibility === "public";
  if (targetIsPublic) {
    await tx
      .update(contents)
      .set({
        firstPublicAt: sql`coalesce(${contents.firstPublicAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
        visibilityVersion: sql`${contents.visibilityVersion} + 1`,
      })
      .where(eq(contents.id, primary.id));
  }

  await tx
    .update(inputAttempts)
    .set({
      resultCollectionId: targetCollectionId,
      resultContentId: primary.id,
      updatedAt: now,
    })
    .where(
      and(
        eq(inputAttempts.accountId, principal.accountId),
        eq(inputAttempts.resultContentId, owned.id),
      ),
    );

  return {
    ...primary,
    collectionId: targetCollectionId,
    sourceChannel:
      owned.sourceChannel === "wechat" ||
      targetCollection.sourceChannel === "wechat"
        ? "wechat"
        : "web",
  };
}

async function applyContentEnrichmentInTransaction(
  tx: AttentionTransaction, principal: ContentEnrichmentPrincipal, input: SubmitContentEnrichmentInput, reviewed?: ContentEnrichmentPlan,
): Promise<SubmitContentEnrichmentResult> {
  const { tags, title, resolved_url: resolvedUrl } = input;
  await setAccountContext(tx, principal.accountId);
  const [owned] = await tx
    .select({
      collectionId: collections.id,
      communityModerationStatus: contents.communityModerationStatus,
      contentStatus: contents.contentStatus,
      id: contents.id,
      publicSafetyStatus: contents.publicSafetyStatus,
      sourceChannel: collections.sourceChannel,
      summaryStatus: contents.summaryStatus,
      takedownStatus: contents.takedownStatus,
    })
    .from(collections)
    .innerJoin(contents, eq(contents.id, collections.contentId))
    .where(
      and(
        eq(collections.accountId, principal.accountId),
        eq(collections.contentId, input.content_id),
        eq(collections.collectionStatus, "active"),
      ),
    )
    .for("update")
    .limit(1);

  if (!owned) {
    throw new ContentEnrichmentServiceError("content_not_found", 404);
  }
  assertEnrichmentEligible(owned);
  const target = await resolveEnrichmentTarget(
    tx,
    principal,
    owned,
    resolvedUrl,
    reviewed,
  );
  assertEnrichmentEligible(target);
  if (target.summaryStatus === "ready") {
    return {
      contentId: target.id,
      status: "already_enriched",
      summaryStatus: "ready",
    };
  }

  const [updated] = await tx
    .update(contents)
    .set({
      aiSummary: input.summary,
      aiTags: tags,
      enrichmentStatus: "complete",
      outboundUrl: resolvedUrl,
      summaryStatus: "ready",
      title,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(contents.id, target.id),
        eq(contents.summaryStatus, target.summaryStatus),
      ),
    )
    .returning({ id: contents.id });

  if (updated && target.sourceChannel === "wechat") {
    const occurredAt = new Date();
    await tx
      .insert(eventLedger)
      .values({
        accountId: null,
        anonymousSessionId: null,
        contentId: target.id,
        dedupeKey: summaryReadyNotificationDedupeKey(target.id),
        eventType: CHANNEL_SUMMARY_READY_EVENT_TYPE,
        metadata: { schema_version: 1 },
        occurredAt,
        requestId: input.idempotency_key,
        scope: "private",
      })
      .onConflictDoNothing({ target: eventLedger.dedupeKey });
  }

  return {
    contentId: target.id,
    status: updated ? "enriched" : "already_enriched",
    summaryStatus: "ready",
  };
}

export async function submitContentEnrichment(db: AttentionDatabase, principal: ContentEnrichmentPrincipal, rawInput: unknown): Promise<SubmitContentEnrichmentResult> {
  const input = normalizeContentEnrichmentInput(rawInput);
  return db.transaction(tx => applyContentEnrichmentInTransaction(tx, principal, input));
}

/** Trusted reviewed path only. No provider/network calls; outer action claim and receipt own the commit. */
export async function applyPreparedContentEnrichment(tx: AttentionTransaction, principal: ContentEnrichmentPrincipal,
  rawPlan: ContentEnrichmentPlan): Promise<SubmitContentEnrichmentResult> {
  return tx.transaction(async savepoint => {
    const plan = await lockAndRevalidateContentEnrichmentPlan(savepoint, principal.accountId, rawPlan);
    const result = await applyContentEnrichmentInTransaction(savepoint, principal, plan.input, plan);
    const [target] = await savepoint.select().from(collections).where(and(eq(collections.accountId, principal.accountId),
      eq(collections.contentId, plan.effects.winnerContentId))).limit(1);
    const [content] = await savepoint.select().from(contents).where(eq(contents.id, plan.effects.winnerContentId)).limit(1);
    if (!target || !content || target.collectionStatus !== "active" || target.visibility !== plan.effects.resultingVisibility ||
        (target.filterRevokedAt?.toISOString() ?? null) !== plan.effects.resultingFilterRevokedAt ||
        target.moderationStatus !== plan.effects.resultingModeration || target.sourceChannel !== plan.effects.resultingSourceChannel ||
        content.summaryStatus !== "ready" || (plan.effects.writeSharedSummary && (content.aiSummary !== plan.input.summary ||
          content.title !== plan.input.title || content.outboundUrl !== plan.input.resolved_url)))
      throw new ContentEnrichmentPlanError("enrichment_target_changed");
    // Domain/profile rows are not arbitrarily privilege-expanded for locking.
    // Re-read their current publication inputs at the effect linearization point.
    const [domain] = await savepoint.select({ active: domains.active }).from(domains).where(eq(domains.id, target.domainId)).limit(1);
    const [account] = await savepoint.select({ status: accounts.status }).from(accounts).where(eq(accounts.id, principal.accountId)).limit(1);
    const [filter] = await savepoint.select({ active: filterProfiles.active, revokedAt: filterProfiles.revokedAt }).from(filterProfiles)
      .where(eq(filterProfiles.accountId, principal.accountId)).limit(1);
    if ((domain?.active === true) !== plan.snapshot.domainActive || (account?.status === "active") !== plan.snapshot.accountActive ||
        (filter?.active === true && filter.revokedAt === null) !== plan.snapshot.filterActive)
      throw new ContentEnrichmentPlanError("enrichment_target_changed");
    const effectivelyPublic = target.visibility === "public" && target.moderationStatus === "clear" &&
      target.filterRevokedAt === null && account?.status === "active" && filter?.active === true && filter.revokedAt === null &&
      domain?.active === true && content.contentStatus === "active" && content.publicSafetyStatus === "allowed" &&
      content.communityModerationStatus === "clear" && content.takedownStatus === "none";
    if (effectivelyPublic !== plan.effects.effectivelyPublic) throw new ContentEnrichmentPlanError("enrichment_target_changed");
    return result;
  });
}
