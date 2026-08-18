import "server-only";

import {
  and,
  CollectionRepositoryError,
  collections,
  contents,
  eq,
  filterProfiles,
  inputAttempts,
  setAccountContext,
  setCollectionVisibility,
  type AttentionDatabase,
} from "@attention/db";
import { isEffectivelyPublic } from "@attention/domain";
import { z } from "zod";

import { enrichmentResponseFields } from "./content-enrichment-decision";

export const collectionStatusRequestSchema = z
  .object({
    attempt_id: z.string().uuid().optional(),
    collection_id: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.attempt_id === undefined) !==
      (value.collection_id === undefined),
    { message: "Provide exactly one of attempt_id or collection_id" },
  );

export const updateCollectionVisibilityRequestSchema = z
  .object({
    collection_id: z.string().uuid(),
    visibility: z.enum(["private", "public"]),
  })
  .strict();

export type CollectionStatusRequest = z.infer<
  typeof collectionStatusRequestSchema
>;
export type UpdateCollectionVisibilityRequest = z.infer<
  typeof updateCollectionVisibilityRequestSchema
>;

export type CollectionStatusServiceErrorCode =
  | "account_not_active"
  | "attempt_not_found"
  | "collection_deleted"
  | "collection_not_found"
  | "filter_required"
  | "invalid_request";

export class CollectionStatusServiceError extends Error {
  readonly code: CollectionStatusServiceErrorCode;
  readonly httpStatus: number;

  constructor(code: CollectionStatusServiceErrorCode, httpStatus: number) {
    super(code);
    this.name = "CollectionStatusServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

type AttemptStatus = (typeof inputAttempts.$inferSelect)["status"];

export interface CollectionAttemptStatusResult {
  attempt_id: string;
  error_code: string | null;
  next_action: "none" | "retry" | "select_candidate" | "wait";
  received_at: string;
  retry_after_seconds: number | null;
  selection_expires_at: string | null;
  status: AttemptStatus;
  updated_at: string;
}

export interface OwnedCollectionStatusResult {
  collected_at: string;
  collection_id: string;
  collection_status: "active" | "deleted";
  effectively_public: boolean;
  filter_revoked_at: string | null;
  moderation_status: "blocked" | "clear";
  original_url: string | null;
  public_since: string | null;
  updated_at: string;
  visibility: "private" | "public";
}

export interface OwnedContentStatusResult {
  community_moderation_status: "clear" | "hidden" | "pending_review";
  content_id: string;
  content_status: "active" | "merged";
  content_type: string;
  enrichment_action: "reuse_summary" | "generate_summary" | "none";
  enrichment_status: "complete" | "failed" | "partial" | "pending" | "processing";
  public_read_url: string | null;
  public_safety_status: "allowed" | "blocked";
  source: string;
  summary_status: "hidden" | "pending" | "ready" | "unavailable";
  takedown_status: "none" | "removed";
  title: string | null;
  updated_at: string;
}

export interface CollectionStatusResult {
  attempt: CollectionAttemptStatusResult | null;
  collection: OwnedCollectionStatusResult | null;
  content: OwnedContentStatusResult | null;
}

export interface UpdateCollectionVisibilityResult {
  collection_id: string;
  effectively_public: boolean;
  original_url: string | null;
  updated_at: string;
  visibility: "private" | "public";
}

export interface CollectionStatusPrincipal {
  accountId: string;
}

function parseStatusRequest(rawInput: unknown): CollectionStatusRequest {
  const parsed = collectionStatusRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new CollectionStatusServiceError("invalid_request", 400);
  }
  return parsed.data;
}

function parseVisibilityRequest(
  rawInput: unknown,
): UpdateCollectionVisibilityRequest {
  const parsed = updateCollectionVisibilityRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new CollectionStatusServiceError("invalid_request", 400);
  }
  return parsed.data;
}

function attemptNextAction(status: AttemptStatus): Pick<
  CollectionAttemptStatusResult,
  "next_action" | "retry_after_seconds"
> {
  if (status === "processing") {
    return { next_action: "wait", retry_after_seconds: 15 };
  }
  if (status === "resolution_pending") {
    return { next_action: "retry", retry_after_seconds: 300 };
  }
  if (status === "ambiguous") {
    return { next_action: "select_candidate", retry_after_seconds: null };
  }
  return { next_action: "none", retry_after_seconds: null };
}

function serializeAttempt(
  attempt: typeof inputAttempts.$inferSelect,
): CollectionAttemptStatusResult {
  return {
    attempt_id: attempt.id,
    error_code: attempt.errorCode,
    ...attemptNextAction(attempt.status),
    received_at: attempt.receivedAt.toISOString(),
    selection_expires_at: attempt.selectionExpiresAt?.toISOString() ?? null,
    status: attempt.status,
    updated_at: attempt.updatedAt.toISOString(),
  };
}

async function loadOwnedCollectionStatus(
  db: AttentionDatabase,
  accountId: string,
  collectionId: string,
): Promise<{
  collection: OwnedCollectionStatusResult;
  content: OwnedContentStatusResult;
} | null> {
  return db.transaction(async (tx) => {
    await setAccountContext(tx, accountId);
    const [row] = await tx
      .select({
        collectedAt: collections.collectedAt,
        aiSummary: contents.aiSummary,
        collectionId: collections.id,
        collectionStatus: collections.collectionStatus,
        collectionUpdatedAt: collections.updatedAt,
        communityModerationStatus: contents.communityModerationStatus,
        contentId: contents.id,
        contentStatus: contents.contentStatus,
        contentType: contents.contentType,
        contentUpdatedAt: contents.updatedAt,
        enrichmentStatus: contents.enrichmentStatus,
        filterActive: filterProfiles.active,
        filterProfileRevokedAt: filterProfiles.revokedAt,
        filterRevokedAt: collections.filterRevokedAt,
        moderationStatus: collections.moderationStatus,
        outboundUrl: contents.outboundUrl,
        publicSafetyStatus: contents.publicSafetyStatus,
        publicSince: collections.publicSince,
        source: contents.source,
        summaryStatus: contents.summaryStatus,
        takedownStatus: contents.takedownStatus,
        title: contents.title,
        visibility: collections.visibility,
      })
      .from(collections)
      .innerJoin(contents, eq(contents.id, collections.contentId))
      .leftJoin(filterProfiles, eq(filterProfiles.accountId, collections.accountId))
      .where(
        and(
          eq(collections.id, collectionId),
          eq(collections.accountId, accountId),
        ),
      )
      .limit(1);
    if (!row) return null;

    const effectivelyPublic = isEffectivelyPublic(
      {
        collectedAt: row.collectedAt,
        collectionStatus: row.collectionStatus,
        filterRevokedAt: row.filterRevokedAt,
        moderationStatus: row.moderationStatus,
        publicSince: row.publicSince,
        visibility: row.visibility,
      },
      {
        filterActive:
          row.filterActive === true && row.filterProfileRevokedAt === null,
        memberActive: false,
      },
      {
        communityModerationStatus: row.communityModerationStatus,
        contentStatus: row.contentStatus,
        publicSafetyStatus: row.publicSafetyStatus,
        takedownStatus: row.takedownStatus,
      },
    );

    return {
      collection: {
        collected_at: row.collectedAt.toISOString(),
        collection_id: row.collectionId,
        collection_status: row.collectionStatus,
        effectively_public: effectivelyPublic,
        filter_revoked_at: row.filterRevokedAt?.toISOString() ?? null,
        moderation_status: row.moderationStatus,
        original_url:
          row.collectionStatus === "active" &&
          row.moderationStatus === "clear" &&
          row.publicSafetyStatus === "allowed" &&
          row.takedownStatus === "none"
            ? `/out/mine/${row.collectionId}`
            : null,
        public_since: row.publicSince?.toISOString() ?? null,
        updated_at: row.collectionUpdatedAt.toISOString(),
        visibility: row.visibility,
      },
      content: {
        community_moderation_status: row.communityModerationStatus,
        content_id: row.contentId,
        content_status: row.contentStatus,
        content_type: row.contentType,
        ...enrichmentResponseFields(
          {
            aiSummary: row.aiSummary,
            communityModerationStatus: row.communityModerationStatus,
            contentStatus: row.contentStatus,
            publicSafetyStatus: row.publicSafetyStatus,
            summaryStatus: row.summaryStatus,
            takedownStatus: row.takedownStatus,
          },
          row.outboundUrl,
        ),
        enrichment_status: row.enrichmentStatus,
        public_safety_status: row.publicSafetyStatus,
        source: row.source,
        takedown_status: row.takedownStatus,
        title: row.title,
        updated_at: row.contentUpdatedAt.toISOString(),
      },
    };
  });
}

export async function getCollectionStatus(
  db: AttentionDatabase,
  principal: CollectionStatusPrincipal,
  rawInput: unknown,
): Promise<CollectionStatusResult> {
  const input = parseStatusRequest(rawInput);
  if (input.attempt_id !== undefined) {
    const [attempt] = await db
      .select()
      .from(inputAttempts)
      .where(
        and(
          eq(inputAttempts.id, input.attempt_id),
          eq(inputAttempts.accountId, principal.accountId),
        ),
      )
      .limit(1);
    if (!attempt) {
      throw new CollectionStatusServiceError("attempt_not_found", 404);
    }
    const result = attempt.resultCollectionId
      ? await loadOwnedCollectionStatus(
          db,
          principal.accountId,
          attempt.resultCollectionId,
        )
      : null;
    return {
      attempt: serializeAttempt(attempt),
      collection: result?.collection ?? null,
      content: result?.content ?? null,
    };
  }

  const collectionId = input.collection_id;
  if (collectionId === undefined) {
    throw new CollectionStatusServiceError("invalid_request", 400);
  }
  const result = await loadOwnedCollectionStatus(
    db,
    principal.accountId,
    collectionId,
  );
  if (!result) {
    throw new CollectionStatusServiceError("collection_not_found", 404);
  }
  return { attempt: null, ...result };
}

function mapRepositoryError(error: CollectionRepositoryError): never {
  if (error.code === "public_requires_filter") {
    throw new CollectionStatusServiceError("filter_required", 403);
  }
  if (error.code === "collection_not_found") {
    throw new CollectionStatusServiceError("collection_not_found", 404);
  }
  if (error.code === "collection_deleted") {
    throw new CollectionStatusServiceError("collection_deleted", 409);
  }
  if (error.code === "account_not_active") {
    throw new CollectionStatusServiceError("account_not_active", 403);
  }
  throw error;
}

export async function updateCollectionVisibility(
  db: AttentionDatabase,
  principal: CollectionStatusPrincipal,
  rawInput: unknown,
): Promise<UpdateCollectionVisibilityResult> {
  const input = parseVisibilityRequest(rawInput);
  try {
    await setCollectionVisibility(db, {
      accountId: principal.accountId,
      collectionId: input.collection_id,
      visibility: input.visibility,
    });
  } catch (error) {
    if (error instanceof CollectionRepositoryError) {
      mapRepositoryError(error);
    }
    throw error;
  }

  const result = await loadOwnedCollectionStatus(
    db,
    principal.accountId,
    input.collection_id,
  );
  if (!result) {
    throw new CollectionStatusServiceError("collection_not_found", 404);
  }
  return {
    collection_id: result.collection.collection_id,
    effectively_public: result.collection.effectively_public,
    original_url: result.collection.original_url,
    updated_at: result.collection.updated_at,
    visibility: result.collection.visibility,
  };
}
