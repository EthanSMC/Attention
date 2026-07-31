import { and, eq } from "drizzle-orm";

import type { AttentionDatabase, AttentionTransaction } from "../client";
import {
  contentAliases,
  contentIdentities,
  contents,
  type Content
} from "../schema";

export interface UpsertContentByIdentityInput {
  dedupeKey: string;
  normalizedUrl: string;
  outboundUrl: string;
  canonicalUrl?: string;
  source: string;
  contentType?: string;
  sourceAdapter: string;
  adapterVersion: string;
  identityKind?: "normalized" | "canonical";
}

export interface UpsertContentByIdentityResult {
  content: Content;
  created: boolean;
}

/**
 * Claims a deterministic identity under the database unique constraint. A
 * losing concurrent request removes its candidate Content in the same
 * transaction, so no orphan can become visible.
 */
export async function upsertContentByIdentityInTransaction(
  tx: AttentionTransaction,
  input: UpsertContentByIdentityInput
): Promise<UpsertContentByIdentityResult> {
  if (!input.dedupeKey.trim()) {
    throw new Error("dedupeKey must not be empty");
  }

  const candidateContentId = globalThis.crypto.randomUUID();
  const [candidate] = await tx
    .insert(contents)
    .values({
      id: candidateContentId,
      outboundUrl: input.outboundUrl,
      normalizedUrl: input.normalizedUrl,
      canonicalUrl: input.canonicalUrl ?? input.normalizedUrl,
      source: input.source,
      contentType: input.contentType ?? "webpage"
    })
    .returning();

  if (!candidate) {
    throw new Error("Failed to create candidate content");
  }

  const [claimedIdentity] = await tx
    .insert(contentIdentities)
    .values({
      contentId: candidateContentId,
      dedupeKey: input.dedupeKey,
      normalizedUrl: input.normalizedUrl,
      sourceAdapter: input.sourceAdapter,
      adapterVersion: input.adapterVersion,
      identityKind: input.identityKind ?? "normalized"
    })
    .onConflictDoNothing({ target: contentIdentities.dedupeKey })
    .returning({ contentId: contentIdentities.contentId });

  if (claimedIdentity) {
    return { content: candidate, created: true };
  }

  const [existingIdentity] = await tx
    .select({ contentId: contentIdentities.contentId })
    .from(contentIdentities)
    .where(
      and(eq(contentIdentities.dedupeKey, input.dedupeKey), eq(contentIdentities.active, true))
    )
    .limit(1);

  await tx.delete(contents).where(eq(contents.id, candidateContentId));

  if (!existingIdentity) {
    throw new Error("Content identity conflict resolved without an active identity");
  }

  const [alias] = await tx
    .select({ primaryContentId: contentAliases.primaryContentId })
    .from(contentAliases)
    .where(
      and(
        eq(contentAliases.aliasContentId, existingIdentity.contentId),
        eq(contentAliases.active, true)
      )
    )
    .limit(1);

  const resolvedContentId = alias?.primaryContentId ?? existingIdentity.contentId;
  const [existingContent] = await tx
    .select()
    .from(contents)
    .where(eq(contents.id, resolvedContentId))
    .limit(1);

  if (!existingContent) {
    throw new Error("Content identity points to missing content");
  }

  return { content: existingContent, created: false };
}

export async function upsertContentByIdentity(
  db: AttentionDatabase,
  input: UpsertContentByIdentityInput
): Promise<UpsertContentByIdentityResult> {
  return db.transaction((tx) => upsertContentByIdentityInTransaction(tx, input));
}
