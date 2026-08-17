import type { DatabaseHandle } from "@attention/db";

import {
  isSupportedTaskType,
  METADATA_TASK_TYPE,
  SUMMARY_TASK_TYPE,
  type SupportedTaskType,
} from "./contracts.js";
import { isSafeErrorCode } from "./errors.js";

type JobSql = DatabaseHandle["sql"];

interface ClaimedJobRow {
  attempts: number;
  available_at: string;
  created_at: string;
  id: string;
  locked_at: string;
  locked_by: string;
  max_attempts: number;
  payload: unknown;
  queue: string;
  task_type: string;
  updated_at: string;
}

export interface ClaimedJob {
  attempts: number;
  availableAt: Date;
  createdAt: Date;
  id: string;
  lockedAt: Date;
  lockedBy: string;
  maxAttempts: number;
  payload: unknown;
  queue: string;
  taskType: SupportedTaskType;
  updatedAt: Date;
}

export interface ClaimJobOptions {
  leaseMs: number;
  now?: Date;
  queue: string;
  workerId: string;
}

function assertIdentifier(value: string, name: string) {
  if (!value.trim() || value.length > 60) {
    throw new Error(`${name} must contain 1-60 characters`);
  }
}

function createClaimToken(workerId: string): string {
  return `${workerId}:${globalThis.crypto.randomUUID()}`;
}

/**
 * A single CTE locks one eligible row with SKIP LOCKED and updates it before
 * returning. Expired running jobs can be reclaimed after a worker crash.
 */
export async function claimNextJob(
  sql: JobSql,
  options: ClaimJobOptions,
): Promise<ClaimedJob | null> {
  assertIdentifier(options.queue, "queue");
  assertIdentifier(options.workerId, "workerId");
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1_000) {
    throw new Error("leaseMs must be an integer of at least 1000");
  }

  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - options.leaseMs);
  const nowValue = now.toISOString();
  const staleBeforeValue = staleBefore.toISOString();
  const claimToken = createClaimToken(options.workerId);
  const rows = await sql<ClaimedJobRow[]>`
    WITH candidate AS (
      SELECT id
      FROM jobs
      WHERE queue = ${options.queue}
        AND task_type IN (${METADATA_TASK_TYPE}, ${SUMMARY_TASK_TYPE})
        AND attempts < max_attempts
        AND (
          (status = 'pending' AND available_at <= ${nowValue})
          OR (status = 'running' AND locked_at <= ${staleBeforeValue})
        )
      ORDER BY available_at ASC, created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs AS job
    SET status = 'running',
        attempts = job.attempts + 1,
        locked_at = ${nowValue},
        locked_by = ${claimToken},
        completed_at = NULL,
        last_error_code = NULL,
        updated_at = ${nowValue}
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id,
              job.queue,
              job.task_type,
              job.payload,
              job.attempts,
              job.max_attempts,
              job.available_at,
              job.locked_at,
              job.locked_by,
              job.created_at,
              job.updated_at
  `;

  const row = rows[0];
  if (!row) return null;
  if (!isSupportedTaskType(row.task_type)) {
    throw new Error("Claim query returned an unsupported task type");
  }

  return {
    attempts: row.attempts,
    availableAt: new Date(row.available_at),
    createdAt: new Date(row.created_at),
    id: row.id,
    lockedAt: new Date(row.locked_at),
    lockedBy: row.locked_by,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    queue: row.queue,
    taskType: row.task_type,
    updatedAt: new Date(row.updated_at),
  };
}

export async function renewJobLease(
  sql: JobSql,
  input: { claimToken: string; jobId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const nowValue = now.toISOString();
  const rows = await sql<{ id: string }[]>`
    UPDATE jobs
    SET locked_at = ${nowValue}, updated_at = ${nowValue}
    WHERE id = ${input.jobId}
      AND status = 'running'
      AND locked_by = ${input.claimToken}
    RETURNING id
  `;
  return rows.length === 1;
}

export async function completeJob(
  sql: JobSql,
  input: { claimToken: string; jobId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const nowValue = now.toISOString();
  const rows = await sql<{ id: string }[]>`
    UPDATE jobs
    SET status = 'completed',
        completed_at = ${nowValue},
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = NULL,
        updated_at = ${nowValue}
    WHERE id = ${input.jobId}
      AND status = 'running'
      AND locked_by = ${input.claimToken}
    RETURNING id
  `;
  return rows.length === 1;
}

export interface FailJobResult {
  retryAt: Date | null;
  status: "failed" | "pending";
  updated: boolean;
}

export async function failJob(
  sql: JobSql,
  input: {
    baseRetryMs: number;
    errorCode: string;
    job: ClaimedJob;
    maxRetryMs: number;
    now?: Date;
    random?: () => number;
    retryable: boolean;
  },
): Promise<FailJobResult> {
  if (!isSafeErrorCode(input.errorCode)) {
    throw new Error("Refusing to persist an unsafe error code");
  }

  const now = input.now ?? new Date();
  const terminal = !input.retryable || input.job.attempts >= input.job.maxAttempts;
  const exponent = Math.max(0, input.job.attempts - 1);
  const unjitteredDelay = Math.min(input.maxRetryMs, input.baseRetryMs * 2 ** exponent);
  const jitter = 0.8 + (input.random ?? Math.random)() * 0.4;
  const retryDelay = Math.min(input.maxRetryMs, Math.round(unjitteredDelay * jitter));
  const retryAt = terminal ? null : new Date(now.getTime() + retryDelay);
  const nextStatus = terminal ? "failed" : "pending";
  const availableAt = (retryAt ?? now).toISOString();
  const completedAt = terminal ? now.toISOString() : null;
  const nowValue = now.toISOString();

  const rows = await sql<{ status: "failed" | "pending" }[]>`
    WITH transitioned AS (
      UPDATE jobs
      SET status = ${nextStatus}::job_status,
          available_at = ${availableAt},
          completed_at = ${completedAt},
          locked_at = NULL,
          locked_by = NULL,
          last_error_code = ${input.errorCode},
          updated_at = ${nowValue}
      WHERE id = ${input.job.id}
        AND status = 'running'
        AND locked_by = ${input.job.lockedBy}
      RETURNING status, payload, task_type
    ), content_terminal AS (
      UPDATE contents AS content
      SET enrichment_status = CASE
            WHEN transitioned.task_type = ${SUMMARY_TASK_TYPE}
              AND content.summary_status NOT IN ('ready', 'hidden')
              THEN 'partial'::enrichment_status
            WHEN transitioned.task_type = ${METADATA_TASK_TYPE}
              THEN 'failed'::enrichment_status
            ELSE content.enrichment_status
          END,
          summary_status = CASE
            WHEN transitioned.task_type = ${SUMMARY_TASK_TYPE}
              AND content.summary_status NOT IN ('ready', 'hidden')
              THEN 'unavailable'::summary_status
            ELSE content.summary_status
          END,
          updated_at = ${nowValue}
      FROM transitioned
      WHERE transitioned.status = 'failed'
        AND jsonb_typeof(transitioned.payload) = 'object'
        AND content.id::text = (transitioned.payload ->> 'contentId')
        AND content.content_status = 'active'
        AND content.public_safety_status = 'allowed'
        AND content.takedown_status = 'none'
        AND (
          transitioned.task_type = ${METADATA_TASK_TYPE}
          OR content.summary_status NOT IN ('ready', 'hidden')
        )
      RETURNING content.id
    )
    SELECT transitioned.status
    FROM transitioned
    CROSS JOIN (SELECT count(*) FROM content_terminal) AS content_updates
  `;

  return {
    retryAt,
    status: nextStatus,
    updated: rows.length === 1,
  };
}

export async function reapExhaustedJobs(
  sql: JobSql,
  input: { leaseMs: number; now?: Date; queue: string },
): Promise<number> {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - input.leaseMs);
  const nowValue = now.toISOString();
  const staleBeforeValue = staleBefore.toISOString();
  const rows = await sql<{ count: number }[]>`
    WITH transitioned AS (
      UPDATE jobs
      SET status = 'failed',
          completed_at = ${nowValue},
          locked_at = NULL,
          locked_by = NULL,
          last_error_code = 'lease_expired',
          updated_at = ${nowValue}
      WHERE queue = ${input.queue}
        AND task_type IN (${METADATA_TASK_TYPE}, ${SUMMARY_TASK_TYPE})
        AND status = 'running'
        AND attempts >= max_attempts
        AND locked_at <= ${staleBeforeValue}
      RETURNING id, payload, task_type
    ), content_terminal AS (
      UPDATE contents AS content
      SET enrichment_status = CASE
            WHEN transitioned.task_type = ${SUMMARY_TASK_TYPE}
              AND content.summary_status NOT IN ('ready', 'hidden')
              THEN 'partial'::enrichment_status
            WHEN transitioned.task_type = ${METADATA_TASK_TYPE}
              THEN 'failed'::enrichment_status
            ELSE content.enrichment_status
          END,
          summary_status = CASE
            WHEN transitioned.task_type = ${SUMMARY_TASK_TYPE}
              AND content.summary_status NOT IN ('ready', 'hidden')
              THEN 'unavailable'::summary_status
            ELSE content.summary_status
          END,
          updated_at = ${nowValue}
      FROM transitioned
      WHERE jsonb_typeof(transitioned.payload) = 'object'
        AND content.id::text = (transitioned.payload ->> 'contentId')
        AND content.content_status = 'active'
        AND content.public_safety_status = 'allowed'
        AND content.takedown_status = 'none'
        AND (
          transitioned.task_type = ${METADATA_TASK_TYPE}
          OR content.summary_status NOT IN ('ready', 'hidden')
        )
      RETURNING content.id
    )
    SELECT count(transitioned.id)::integer AS count
    FROM transitioned
    CROSS JOIN (SELECT count(*) FROM content_terminal) AS content_updates
  `;
  return rows[0]?.count ?? 0;
}

export async function deleteExpiredCandidateSets(
  sql: JobSql,
  input: { now?: Date } = {},
): Promise<number> {
  const nowValue = (input.now ?? new Date()).toISOString();
  const rows = await sql<{ count: number }[]>`
    WITH deleted AS (
      DELETE FROM pending_candidate_sets
      WHERE expires_at <= ${nowValue}
      RETURNING id
    )
    SELECT count(*)::integer AS count FROM deleted
  `;
  return rows[0]?.count ?? 0;
}
