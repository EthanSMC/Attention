import { resolveAccountCapabilities } from "@attention/auth";
import {
  and,
  collections,
  contents,
  eq,
  jobs,
  type AttentionDatabase,
} from "@attention/db";

import {
  ENRICHMENT_QUEUE,
  METADATA_TASK_TYPE,
  parseContentJobPayload,
  SUMMARY_TASK_TYPE,
  type MetadataResult,
  type SummaryResult,
} from "./contracts.js";
import { JobExecutionError, LostLeaseError } from "./errors.js";
import type { ClaimedJob } from "./job-repository.js";

export interface ContentHandlerContext {
  author: string | null;
  contentId: string;
  outboundUrl: string;
  publishedAt: Date | null;
  signal: AbortSignal;
  source: string;
  title: string | null;
}

export interface JobHandlers {
  metadata(context: ContentHandlerContext): Promise<MetadataResult>;
  summary(context: ContentHandlerContext): Promise<SummaryResult>;
}

export function createStubHandlers(): JobHandlers {
  return {
    metadata: async () => {
      throw new JobExecutionError("metadata_handler_not_configured", {
        retryable: false,
      });
    },
    summary: async () => {
      throw new JobExecutionError("summary_handler_not_configured", {
        retryable: false,
      });
    },
  };
}

function parsePayload(job: ClaimedJob) {
  try {
    return parseContentJobPayload(job.payload);
  } catch {
    throw new JobExecutionError("invalid_job_payload", { retryable: false });
  }
}

async function loadEligibleContent(db: AttentionDatabase, contentId: string) {
  const [content] = await db
    .select({
      author: contents.author,
      contentStatus: contents.contentStatus,
      id: contents.id,
      outboundUrl: contents.outboundUrl,
      publicSafetyStatus: contents.publicSafetyStatus,
      publishedAt: contents.publishedAt,
      source: contents.source,
      summaryStatus: contents.summaryStatus,
      takedownStatus: contents.takedownStatus,
      title: contents.title,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);

  if (!content) {
    throw new JobExecutionError("content_not_found", { retryable: false });
  }

  if (
    content.contentStatus !== "active" ||
    content.publicSafetyStatus !== "allowed" ||
    content.takedownStatus !== "none"
  ) {
    throw new JobExecutionError("content_not_eligible", { retryable: false });
  }

  return content;
}

function validateNullableText(
  value: string | null,
  field: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new JobExecutionError(`invalid_${field}`, { retryable: false });
  }
  return trimmed;
}

function validateMetadata(result: MetadataResult): MetadataResult {
  if (
    result.publishedAt !== null &&
    (!(result.publishedAt instanceof Date) || Number.isNaN(result.publishedAt.getTime()))
  ) {
    throw new JobExecutionError("invalid_published_at", { retryable: false });
  }

  const cachedFaviconAssetKey = validateNullableText(
    result.cachedFaviconAssetKey,
    "favicon_asset_key",
    512,
  );
  if (
    cachedFaviconAssetKey &&
    (cachedFaviconAssetKey.includes("://") ||
      cachedFaviconAssetKey.includes("?") ||
      cachedFaviconAssetKey.includes("#"))
  ) {
    throw new JobExecutionError("invalid_favicon_asset_key", { retryable: false });
  }

  return {
    author: validateNullableText(result.author, "author", 1_024),
    cachedFaviconAssetKey,
    publishedAt: result.publishedAt,
    title: validateNullableText(result.title, "title", 4_096),
  };
}

function validateSummary(result: SummaryResult): SummaryResult {
  if (result.status !== "ready" && result.status !== "unavailable") {
    throw new JobExecutionError("invalid_summary_result", { retryable: false });
  }
  if (!Array.isArray(result.tags) || result.tags.length > 8) {
    throw new JobExecutionError("invalid_summary_tags", { retryable: false });
  }
  const tags = [...new Set(result.tags.map((tag) => {
    if (typeof tag !== "string") {
      throw new JobExecutionError("invalid_summary_tags", { retryable: false });
    }
    const normalized = tag.trim();
    if (!normalized || normalized.length > 64) {
      throw new JobExecutionError("invalid_summary_tags", { retryable: false });
    }
    return normalized;
  }))];
  if (result.status === "unavailable") {
    if (result.summary !== null) {
      throw new JobExecutionError("invalid_summary_result", { retryable: false });
    }
    return { ...result, tags };
  }

  const summary = validateNullableText(result.summary, "summary", 2_000);
  if (!summary) {
    throw new JobExecutionError("invalid_summary_result", { retryable: false });
  }
  return { status: "ready", summary, tags };
}

/**
 * Hosted AI is decided when the metadata job runs. An account upgrading later
 * does not scan or enqueue its historical Free collections.
 */
export async function shouldScheduleHostedAi(
  db: AttentionDatabase,
  contentId: string,
): Promise<boolean> {
  const owners = await db
    .select({ accountId: collections.accountId })
    .from(collections)
    .where(
      and(
        eq(collections.contentId, contentId),
        eq(collections.collectionStatus, "active"),
      ),
    );
  for (const accountId of new Set(owners.map((owner) => owner.accountId))) {
    const capabilities = await resolveAccountCapabilities(db, accountId);
    if (capabilities.isMember) return true;
  }
  return false;
}

async function finalizeMetadata(
  db: AttentionDatabase,
  job: ClaimedJob,
  contentId: string,
  result: MetadataResult,
  scheduleSummary: boolean,
  summaryStatus: "failed" | "hidden" | "pending" | "ready" | "unavailable",
) {
  const completed = await db.transaction(async (tx) => {
    const [lease] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, "running"),
          eq(jobs.lockedBy, job.lockedBy),
        ),
      )
      .for("update")
      .limit(1);

    if (!lease) return false;

    const now = new Date();
    const [updatedContent] = await tx
      .update(contents)
      .set({
        author: result.author,
        cachedFaviconAssetKey: result.cachedFaviconAssetKey,
        enrichmentStatus: "partial",
        publishedAt: result.publishedAt,
        summaryStatus: summaryStatus === "ready" || summaryStatus === "hidden"
          ? summaryStatus
          : scheduleSummary
            ? "pending"
            : "unavailable",
        title: result.title,
        updatedAt: now,
      })
      .where(
        and(
          eq(contents.id, contentId),
          eq(contents.contentStatus, "active"),
          eq(contents.publicSafetyStatus, "allowed"),
          eq(contents.takedownStatus, "none"),
        ),
      )
      .returning({ id: contents.id });

    if (!updatedContent) {
      throw new JobExecutionError("content_became_ineligible", { retryable: false });
    }

    if (scheduleSummary && summaryStatus !== "ready" && summaryStatus !== "hidden") {
      await tx
        .insert(jobs)
        .values({
          idempotencyKey: `${SUMMARY_TASK_TYPE}:${contentId}`,
          payload: { contentId },
          queue: ENRICHMENT_QUEUE,
          taskType: SUMMARY_TASK_TYPE,
        })
        .onConflictDoNothing({ target: jobs.idempotencyKey });
    }

    await tx
      .update(jobs)
      .set({
        completedAt: now,
        lastErrorCode: null,
        lockedAt: null,
        lockedBy: null,
        status: "completed",
        updatedAt: now,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, job.lockedBy)));

    return true;
  });

  if (!completed) throw new LostLeaseError();
}

async function finalizeSummary(
  db: AttentionDatabase,
  job: ClaimedJob,
  contentId: string,
  result: SummaryResult,
) {
  const completed = await db.transaction(async (tx) => {
    const [lease] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, "running"),
          eq(jobs.lockedBy, job.lockedBy),
        ),
      )
      .for("update")
      .limit(1);

    if (!lease) return false;

    const now = new Date();
    const [updatedContent] = await tx
      .update(contents)
      .set({
        aiSummary: result.summary,
        aiTags: result.tags,
        enrichmentStatus: result.status === "ready" ? "complete" : "partial",
        summaryStatus: result.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(contents.id, contentId),
          eq(contents.contentStatus, "active"),
          eq(contents.publicSafetyStatus, "allowed"),
          eq(contents.takedownStatus, "none"),
        ),
      )
      .returning({ id: contents.id });

    if (!updatedContent) {
      throw new JobExecutionError("content_became_ineligible", { retryable: false });
    }

    await tx
      .update(jobs)
      .set({
        completedAt: now,
        lastErrorCode: null,
        lockedAt: null,
        lockedBy: null,
        status: "completed",
        updatedAt: now,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, job.lockedBy)));

    return true;
  });

  if (!completed) throw new LostLeaseError();
}

export async function executeClaimedJob(
  db: AttentionDatabase,
  job: ClaimedJob,
  handlers: JobHandlers,
  signal: AbortSignal,
): Promise<void> {
  const payload = parsePayload(job);
  const content = await loadEligibleContent(db, payload.contentId);
  const context: ContentHandlerContext = {
    author: content.author,
    contentId: content.id,
    outboundUrl: content.outboundUrl,
    publishedAt: content.publishedAt,
    signal,
    source: content.source,
    title: content.title,
  };

  if (job.taskType === METADATA_TASK_TYPE) {
    const result = validateMetadata(await handlers.metadata(context));
    const scheduleSummary = await shouldScheduleHostedAi(db, content.id);
    await finalizeMetadata(
      db,
      job,
      content.id,
      result,
      scheduleSummary,
      content.summaryStatus,
    );
    return;
  }

  if (!(await shouldScheduleHostedAi(db, content.id))) {
    await finalizeSummary(db, job, content.id, {
      status: "unavailable",
      summary: null,
      tags: [],
    });
    return;
  }
  const result = validateSummary(await handlers.summary(context));
  await finalizeSummary(db, job, content.id, result);
}
