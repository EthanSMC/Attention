import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import type { AttentionDatabase, AttentionTransaction } from "../client";
import {
  accounts,
  collectionEvents,
  collections,
  contents,
  entitlements,
  filterProfiles,
  type Collection
} from "../schema";

export type CollectionRepositoryErrorCode =
  | "account_not_active"
  | "collection_not_found"
  | "collection_deleted"
  | "member_required"
  | "public_requires_filter";

export class CollectionRepositoryError extends Error {
  readonly code: CollectionRepositoryErrorCode;

  constructor(code: CollectionRepositoryErrorCode) {
    super(code);
    this.name = "CollectionRepositoryError";
    this.code = code;
  }
}

export interface UpsertCollectionInput {
  accountId: string;
  contentId: string;
  domainId: string;
  visibility: "public" | "private";
  sourceChannel: "web" | "wechat";
  now?: Date;
}

export interface UpsertCollectionResult {
  collection: Collection;
  status: "created" | "already_collected" | "restored";
}

async function getAccountCapabilities(
  tx: AttentionTransaction,
  accountId: string,
  now: Date
): Promise<{ isFilter: boolean; isMember: boolean }> {
  const [account] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.status, "active")))
    .limit(1);
  if (!account) {
    throw new CollectionRepositoryError("account_not_active");
  }

  const [filter] = await tx
    .select({ accountId: filterProfiles.accountId })
    .from(filterProfiles)
    .where(
      and(
        eq(filterProfiles.accountId, accountId),
        eq(filterProfiles.active, true),
        isNull(filterProfiles.revokedAt)
      )
    )
    .limit(1);

  const [member] = await tx
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.accountId, accountId),
        eq(entitlements.memberEnabled, true),
        lte(entitlements.startsAt, now),
        or(isNull(entitlements.endsAt), gt(entitlements.endsAt, now))
      )
    )
    .limit(1);

  return { isFilter: Boolean(filter), isMember: Boolean(member) || Boolean(filter) };
}

function collectionState(collection: Collection): Record<string, unknown> {
  return {
    collectionStatus: collection.collectionStatus,
    visibility: collection.visibility,
    publicSince: collection.publicSince?.toISOString() ?? null,
    filterRevokedAt: collection.filterRevokedAt?.toISOString() ?? null,
    moderationStatus: collection.moderationStatus,
    collectedAt: collection.collectedAt.toISOString()
  };
}

async function notePublicMutation(
  tx: AttentionTransaction,
  contentId: string,
  now: Date
): Promise<void> {
  const [effectivePublicCollection] = await tx
    .select({ id: collections.id })
    .from(collections)
    .innerJoin(filterProfiles, eq(filterProfiles.accountId, collections.accountId))
    .innerJoin(contents, eq(contents.id, collections.contentId))
    .where(
      and(
        eq(collections.contentId, contentId),
        eq(collections.collectionStatus, "active"),
        eq(collections.visibility, "public"),
        isNull(collections.filterRevokedAt),
        eq(collections.moderationStatus, "clear"),
        eq(filterProfiles.active, true),
        isNull(filterProfiles.revokedAt),
        eq(contents.contentStatus, "active"),
        eq(contents.publicSafetyStatus, "allowed"),
        eq(contents.takedownStatus, "none")
      )
    )
    .limit(1);

  await tx
    .update(contents)
    .set({
      firstPublicAt: effectivePublicCollection
        ? sql`coalesce(${contents.firstPublicAt}, ${sql.param(now, contents.firstPublicAt)})`
        : undefined,
      visibilityVersion: sql`${contents.visibilityVersion} + 1`,
      updatedAt: now
    })
    .where(eq(contents.id, contentId));
}

export async function setAccountContext(
  tx: AttentionTransaction,
  accountId: string
): Promise<void> {
  await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
}

export async function upsertCollectionInTransaction(
  tx: AttentionTransaction,
  input: UpsertCollectionInput
): Promise<UpsertCollectionResult> {
  const now = input.now ?? new Date();

  await setAccountContext(tx, input.accountId);
    const capabilities = await getAccountCapabilities(tx, input.accountId, now);
    if (!capabilities.isMember) {
      throw new CollectionRepositoryError("member_required");
    }
    if (input.visibility === "public" && !capabilities.isFilter) {
      throw new CollectionRepositoryError("public_requires_filter");
    }

    const [existing] = await tx
      .select()
      .from(collections)
      .where(
        and(eq(collections.accountId, input.accountId), eq(collections.contentId, input.contentId))
      )
      .for("update")
      .limit(1);

    if (existing?.collectionStatus === "active") {
      return { collection: existing, status: "already_collected" };
    }

    if (existing) {
      const [restored] = await tx
        .update(collections)
        .set({
          domainId: input.domainId,
          visibility: input.visibility,
          publicSince: input.visibility === "public" ? now : null,
          sourceChannel: input.sourceChannel,
          collectionStatus: "active",
          filterRevokedAt: capabilities.isFilter ? null : existing.filterRevokedAt,
          collectedAt: now,
          updatedAt: now
        })
        .where(eq(collections.id, existing.id))
        .returning();
      if (!restored) {
        throw new Error("Failed to restore collection");
      }

      await tx.insert(collectionEvents).values({
        collectionId: restored.id,
        accountId: restored.accountId,
        contentId: restored.contentId,
        eventType: "restored",
        previousState: collectionState(existing),
        nextState: collectionState(restored),
        actorAccountId: input.accountId,
        occurredAt: now
      });

      if (input.visibility === "public") {
        await notePublicMutation(tx, input.contentId, now);
      }
      return { collection: restored, status: "restored" };
    }

    const [created] = await tx
      .insert(collections)
      .values({
        accountId: input.accountId,
        contentId: input.contentId,
        domainId: input.domainId,
        visibility: input.visibility,
        publicSince: input.visibility === "public" ? now : null,
        sourceChannel: input.sourceChannel,
        collectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoNothing({ target: [collections.accountId, collections.contentId] })
      .returning();

    if (!created) {
      const [winner] = await tx
        .select()
        .from(collections)
        .where(
          and(eq(collections.accountId, input.accountId), eq(collections.contentId, input.contentId))
        )
        .limit(1);
      if (!winner) {
        throw new Error("Collection conflict resolved without a winning row");
      }
      return { collection: winner, status: "already_collected" };
    }

    await tx.insert(collectionEvents).values({
      collectionId: created.id,
      accountId: created.accountId,
      contentId: created.contentId,
      eventType: "created",
      nextState: collectionState(created),
      actorAccountId: input.accountId,
      occurredAt: now
    });

    if (input.visibility === "public") {
      await notePublicMutation(tx, input.contentId, now);
    }
    return { collection: created, status: "created" };
}

export async function upsertCollection(
  db: AttentionDatabase,
  input: UpsertCollectionInput
): Promise<UpsertCollectionResult> {
  return db.transaction((tx) => upsertCollectionInTransaction(tx, input));
}

export async function setCollectionVisibility(
  db: AttentionDatabase,
  input: { accountId: string; collectionId: string; visibility: "public" | "private"; now?: Date }
): Promise<Collection> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    const capabilities = await getAccountCapabilities(tx, input.accountId, now);
    if (!capabilities.isMember) {
      throw new CollectionRepositoryError("member_required");
    }
    if (input.visibility === "public" && !capabilities.isFilter) {
      throw new CollectionRepositoryError("public_requires_filter");
    }

    const [existing] = await tx
      .select()
      .from(collections)
      .where(and(eq(collections.id, input.collectionId), eq(collections.accountId, input.accountId)))
      .for("update")
      .limit(1);
    if (!existing) {
      throw new CollectionRepositoryError("collection_not_found");
    }
    if (existing.collectionStatus === "deleted") {
      throw new CollectionRepositoryError("collection_deleted");
    }
    if (
      existing.visibility === input.visibility &&
      (input.visibility === "private" || existing.filterRevokedAt === null)
    ) {
      return existing;
    }

    const [updated] = await tx
      .update(collections)
      .set({
        visibility: input.visibility,
        publicSince: input.visibility === "public" ? now : null,
        filterRevokedAt: input.visibility === "public" ? null : existing.filterRevokedAt,
        updatedAt: now
      })
      .where(eq(collections.id, existing.id))
      .returning();
    if (!updated) {
      throw new Error("Failed to update collection visibility");
    }

    await tx.insert(collectionEvents).values({
      collectionId: updated.id,
      accountId: updated.accountId,
      contentId: updated.contentId,
      eventType: input.visibility === "public" ? "made_public" : "made_private",
      previousState: collectionState(existing),
      nextState: collectionState(updated),
      actorAccountId: input.accountId,
      occurredAt: now
    });

    await notePublicMutation(tx, updated.contentId, now);
    return updated;
  });
}

export async function deleteCollection(
  db: AttentionDatabase,
  input: { accountId: string; collectionId: string; now?: Date }
): Promise<Collection> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    const [existing] = await tx
      .select()
      .from(collections)
      .where(and(eq(collections.id, input.collectionId), eq(collections.accountId, input.accountId)))
      .for("update")
      .limit(1);
    if (!existing) {
      throw new CollectionRepositoryError("collection_not_found");
    }
    if (existing.collectionStatus === "deleted") {
      return existing;
    }

    const [deleted] = await tx
      .update(collections)
      .set({ collectionStatus: "deleted", updatedAt: now })
      .where(eq(collections.id, existing.id))
      .returning();
    if (!deleted) {
      throw new Error("Failed to delete collection");
    }

    await tx.insert(collectionEvents).values({
      collectionId: deleted.id,
      accountId: deleted.accountId,
      contentId: deleted.contentId,
      eventType: "deleted",
      previousState: collectionState(existing),
      nextState: collectionState(deleted),
      actorAccountId: input.accountId,
      occurredAt: now
    });

    if (existing.visibility === "public") {
      await notePublicMutation(tx, existing.contentId, now);
    }
    return deleted;
  });
}
