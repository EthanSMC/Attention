import "server-only";

import {
  and,
  collections,
  contents,
  eq,
  setAccountContext,
  type AttentionDatabase,
} from "@attention/db";
import { z } from "zod";

export const submitContentEnrichmentInputSchema = z
  .object({
    content_id: z.string().uuid(),
    idempotency_key: z.string().trim().min(8).max(128),
    summary: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
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

export async function submitContentEnrichment(
  db: AttentionDatabase,
  principal: ContentEnrichmentPrincipal,
  rawInput: unknown,
): Promise<SubmitContentEnrichmentResult> {
  const input = submitContentEnrichmentInputSchema.parse(rawInput);
  const tags = normalizeTags(input.tags);

  return db.transaction(async (tx) => {
    await setAccountContext(tx, principal.accountId);
    const [owned] = await tx
      .select({
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
    if (owned.summaryStatus === "ready") {
      return {
        contentId: owned.id,
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
        summaryStatus: "ready",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contents.id, owned.id),
          eq(contents.summaryStatus, owned.summaryStatus),
        ),
      )
      .returning({ id: contents.id });

    return {
      contentId: owned.id,
      status: updated ? "enriched" : "already_enriched",
      summaryStatus: "ready",
    };
  });
}
