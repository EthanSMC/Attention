import { eq, jobs, type AttentionDatabase } from "@attention/db";

import {
  ENRICHMENT_QUEUE,
  isUuid,
  METADATA_TASK_TYPE,
  SUMMARY_TASK_TYPE,
  type SupportedTaskType,
} from "./contracts.js";

export interface EnqueueResult {
  enqueued: boolean;
  jobId: string;
  status: "completed" | "failed" | "pending" | "running";
}

async function enqueueContentJob(
  db: AttentionDatabase,
  taskType: SupportedTaskType,
  contentId: string,
): Promise<EnqueueResult> {
  if (!isUuid(contentId)) {
    throw new Error("contentId must be a UUID");
  }

  const idempotencyKey = `${taskType}:${contentId}`;
  const [inserted] = await db
    .insert(jobs)
    .values({
      idempotencyKey,
      payload: { contentId },
      queue: ENRICHMENT_QUEUE,
      taskType,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id, status: jobs.status });

  if (inserted) {
    return { enqueued: true, jobId: inserted.id, status: inserted.status };
  }

  const [existing] = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, idempotencyKey))
    .limit(1);

  if (!existing) {
    throw new Error("Job idempotency conflict resolved without an existing job");
  }

  return { enqueued: false, jobId: existing.id, status: existing.status };
}

/**
 * Web collection only waits for this small idempotent INSERT. It does not wait
 * for fetching or AI work. A successful metadata handler queues the summary.
 */
export function enqueueContentEnrichment(
  db: AttentionDatabase,
  input: { contentId: string },
): Promise<EnqueueResult> {
  return enqueueContentJob(db, METADATA_TASK_TYPE, input.contentId);
}

export function enqueueSummaryJob(
  db: AttentionDatabase,
  input: { contentId: string },
): Promise<EnqueueResult> {
  return enqueueContentJob(db, SUMMARY_TASK_TYPE, input.contentId);
}
