import "server-only";

import { classifySourceUrl, genericWebAdapter } from "@attention/collector";
import {
  and,
  collectionEvents,
  collections,
  contentIdentities,
  contents,
  eq,
  inputAttempts,
  sql,
  setAccountContext,
  type AttentionTransaction,
  type AttentionDatabase,
} from "@attention/db";
import { z } from "zod";

import { validateAgentResolvedPublicUrl } from "./collection-service";

export const submitContentEnrichmentInputSchema = z
  .object({
    content_id: z.string().uuid(),
    idempotency_key: z.string().trim().min(8).max(128),
    resolved_url: z.string().trim().min(1).max(4_096),
    summary: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
    title: z.string().trim().min(1).max(500),
  })
  .strict();

export type SubmitContentEnrichmentInput = z.infer<
  typeof submitContentEnrichmentInputSchema
>;

export interface ContentEnrichmentPrincipal {
  accountId: string;
}

export interface SubmitContentEnrichmentResult {
  contentId: string;
  status: "enriched" | "already_enriched";
  summaryStatus: "ready";
}

export type ContentEnrichmentServiceErrorCode =
  | "content_enrichment_hidden"
  | "content_enrichment_invalid_link"
  | "content_enrichment_unavailable"
  | "content_not_eligible"
  | "content_not_found";

export class ContentEnrichmentServiceError extends Error {
  readonly code: ContentEnrichmentServiceErrorCode;
  readonly httpStatus: number;

  constructor(code: ContentEnrichmentServiceErrorCode, httpStatus: number) {
    super(code);
    this.name = "ContentEnrichmentServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const key = tag.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim();
}

function resolvedIdentity(resolvedUrl: string) {
  const match = classifySourceUrl(resolvedUrl);
  return match?.adapter.identity(resolvedUrl) ??
    genericWebAdapter.identity(resolvedUrl);
}

interface OwnedEnrichmentTarget {
  collectionId: string;
  communityModerationStatus: "clear" | "hidden" | "pending_review";
  contentStatus: "active" | "merged";
  id: string;
  publicSafetyStatus: "allowed" | "blocked";
  summaryStatus: "failed" | "hidden" | "pending" | "ready" | "unavailable";
  takedownStatus: "none" | "removed";
}

function assertEnrichmentEligible(owned: OwnedEnrichmentTarget): void {
  if (owned.summaryStatus === "hidden") {
    throw new ContentEnrichmentServiceError(
      "content_enrichment_hidden",
      409,
    );
  }
  if (
    owned.contentStatus !== "active" ||
    owned.publicSafetyStatus !== "allowed" ||
    owned.takedownStatus !== "none" ||
    owned.communityModerationStatus !== "clear"
  ) {
    throw new ContentEnrichmentServiceError("content_not_eligible", 409);
  }
  if (
    owned.summaryStatus === "unavailable" ||
    owned.summaryStatus === "failed"
  ) {
    throw new ContentEnrichmentServiceError(
      "content_enrichment_unavailable",
      409,
    );
  }
}

async function resolveEnrichmentTarget(
  tx: AttentionTransaction,
  principal: ContentEnrichmentPrincipal,
  owned: OwnedEnrichmentTarget,
  resolvedUrl: string,
): Promise<OwnedEnrichmentTarget> {
  const identity = resolvedIdentity(resolvedUrl);
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
        moderationStatus: currentCollection.moderationStatus,
        publicSince: currentCollection.publicSince,
        sourceChannel: currentCollection.sourceChannel,
        visibility: currentCollection.visibility,
      })
      .onConflictDoNothing({ target: [collections.accountId, collections.contentId] })
      .returning();
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
        firstPublicAt: sql`coalesce(${contents.firstPublicAt}, ${now})`,
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

  return { ...primary, collectionId: targetCollectionId };
}

export async function submitContentEnrichment(
  db: AttentionDatabase,
  principal: ContentEnrichmentPrincipal,
  rawInput: unknown,
): Promise<SubmitContentEnrichmentResult> {
  const input = submitContentEnrichmentInputSchema.parse(rawInput);
  const tags = normalizeTags(input.tags);
  const title = normalizeTitle(input.title);
  const resolvedUrl = validateAgentResolvedPublicUrl(input.resolved_url);
  if (!resolvedUrl) {
    throw new ContentEnrichmentServiceError(
      "content_enrichment_invalid_link",
      422,
    );
  }

  return db.transaction(async (tx) => {
    await setAccountContext(tx, principal.accountId);
    const [owned] = await tx
      .select({
        collectionId: collections.id,
        communityModerationStatus: contents.communityModerationStatus,
        contentStatus: contents.contentStatus,
        id: contents.id,
        publicSafetyStatus: contents.publicSafetyStatus,
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

    return {
      contentId: target.id,
      status: updated ? "enriched" : "already_enriched",
      summaryStatus: "ready",
    };
  });
}
