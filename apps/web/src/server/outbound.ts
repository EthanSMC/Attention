import {
  and,
  collections,
  contents,
  eq,
  publicContentsCurrent,
  sql,
  type AttentionDatabase,
} from "@attention/db";

import { loadPublicContents } from "./content-queries";
import { publicFeedPreviewLimit } from "./public-access";

export async function isPublicContentInsidePreview(
  db: AttentionDatabase,
  publicId: string,
): Promise<boolean> {
  const preview = (await loadPublicContents(db)).slice(0, publicFeedPreviewLimit());
  return preview.some((content) => content.id === publicId);
}

export async function findPublicOutboundUrl(
  db: AttentionDatabase,
  publicId: string,
): Promise<string | null> {
  const [content] = await db
    .select({ outboundUrl: publicContentsCurrent.outboundUrl })
    .from(publicContentsCurrent)
    .where(eq(publicContentsCurrent.publicId, publicId))
    .limit(1);

  return content?.outboundUrl ?? null;
}

export async function findOwnedOutboundUrl(
  db: AttentionDatabase,
  accountId: string,
  collectionId: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    const [content] = await tx
      .select({ outboundUrl: contents.outboundUrl })
      .from(collections)
      .innerJoin(contents, eq(contents.id, collections.contentId))
      .where(
        and(
          eq(collections.id, collectionId),
          eq(collections.accountId, accountId),
          eq(collections.collectionStatus, "active"),
          eq(collections.moderationStatus, "clear"),
          eq(contents.contentStatus, "active"),
          eq(contents.publicSafetyStatus, "allowed"),
          eq(contents.takedownStatus, "none"),
        ),
      )
      .limit(1);

    return content?.outboundUrl ?? null;
  });
}

export function parseSafeOutboundUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
