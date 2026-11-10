import "server-only";
import { classifySourceUrl, genericWebAdapter } from "@attention/collector";
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
  | "enrichment_plan_invalid"
  | "enrichment_target_changed"
  | "enrichment_target_unavailable"
  | "enrichment_notification_target_unavailable"
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

export function normalizeEnrichmentTags(tags: readonly string[]): string[] {
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

export function normalizeEnrichmentTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim();
}

export function enrichmentResolvedIdentity(resolvedUrl: string) {
  const match = classifySourceUrl(resolvedUrl);
  return match?.adapter.identity(resolvedUrl) ??
    genericWebAdapter.identity(resolvedUrl);
}

export interface OwnedEnrichmentTarget {
  collectionId: string;
  communityModerationStatus: "clear" | "hidden" | "pending_review";
  contentStatus: "active" | "merged";
  id: string;
  publicSafetyStatus: "allowed" | "blocked";
  sourceChannel: "web" | "wechat";
  summaryStatus: "failed" | "hidden" | "pending" | "ready" | "unavailable";
  takedownStatus: "none" | "removed";
}

export function assertEnrichmentEligible(owned: OwnedEnrichmentTarget): void {
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

export function normalizeContentEnrichmentInput(rawInput: unknown): SubmitContentEnrichmentInput {
  const input = submitContentEnrichmentInputSchema.parse(rawInput);
  const resolvedUrl = validateAgentResolvedPublicUrl(input.resolved_url);
  if (!resolvedUrl) throw new ContentEnrichmentServiceError("content_enrichment_invalid_link", 422);
  return { ...input, resolved_url: resolvedUrl, title: normalizeEnrichmentTitle(input.title), tags: normalizeEnrichmentTags(input.tags) };
}
