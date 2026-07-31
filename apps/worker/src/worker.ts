import type { DatabaseHandle } from "@attention/db";

import type { WorkerConfig } from "./config.js";
import { LostLeaseError, toSafeJobFailure } from "./errors.js";
import { executeClaimedJob, type JobHandlers } from "./handlers.js";
import {
  claimNextJob,
  deleteExpiredCandidateSets,
  failJob,
  reapExhaustedJobs,
  renewJobLease,
  type ClaimedJob,
} from "./job-repository.js";
import type { WorkerLogger } from "./logger.js";

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);

    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

function startLeaseHeartbeat(
  handle: DatabaseHandle,
  job: ClaimedJob,
  leaseMs: number,
  logger: WorkerLogger,
  controller: AbortController,
): () => void {
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const interval = setInterval(() => {
    void renewJobLease(handle.sql, {
      claimToken: job.lockedBy,
      jobId: job.id,
    })
      .then((renewed) => {
        if (!renewed) {
          controller.abort();
          logger.warn("job_lease_lost", {
            attempt: job.attempts,
            jobId: job.id,
            taskType: job.taskType,
          });
        }
      })
      .catch(() => {
        logger.warn("job_lease_renew_failed", {
          attempt: job.attempts,
          jobId: job.id,
          taskType: job.taskType,
        });
      });
  }, intervalMs);
  interval.unref();
  return () => clearInterval(interval);
}

async function processJob(
  handle: DatabaseHandle,
  job: ClaimedJob,
  handlers: JobHandlers,
  config: WorkerConfig,
  logger: WorkerLogger,
  workerSignal: AbortSignal,
) {
  const jobController = new AbortController();
  const forwardAbort = () => jobController.abort();
  workerSignal.addEventListener("abort", forwardAbort, { once: true });
  const stopHeartbeat = startLeaseHeartbeat(
    handle,
    job,
    config.leaseMs,
    logger,
    jobController,
  );

  try {
    await executeClaimedJob(handle.db, job, handlers, jobController.signal);
    logger.info("job_completed", {
      attempt: job.attempts,
      jobId: job.id,
      taskType: job.taskType,
    });
  } catch (error) {
    if (error instanceof LostLeaseError || jobController.signal.aborted) {
      logger.warn("job_abandoned", {
        attempt: job.attempts,
        jobId: job.id,
        taskType: job.taskType,
      });
      return;
    }

    const failure = toSafeJobFailure(error);
    try {
      const result = await failJob(handle.sql, {
        baseRetryMs: config.baseRetryMs,
        errorCode: failure.code,
        job,
        maxRetryMs: config.maxRetryMs,
        retryable: failure.retryable,
      });

      if (!result.updated) {
        logger.warn("job_failure_lease_lost", {
          attempt: job.attempts,
          errorCode: failure.code,
          jobId: job.id,
          taskType: job.taskType,
        });
        return;
      }

      logger[result.status === "failed" ? "error" : "warn"]("job_failed", {
        attempt: job.attempts,
        errorCode: failure.code,
        jobId: job.id,
        retryScheduled: result.status === "pending",
        taskType: job.taskType,
      });
    } catch {
      logger.error("job_failure_record_failed", {
        attempt: job.attempts,
        errorCode: failure.code,
        jobId: job.id,
        taskType: job.taskType,
      });
    }
  } finally {
    stopHeartbeat();
    workerSignal.removeEventListener("abort", forwardAbort);
  }
}

async function runSlot(
  slot: number,
  handle: DatabaseHandle,
  handlers: JobHandlers,
  config: WorkerConfig,
  logger: WorkerLogger,
  signal: AbortSignal,
) {
  const slotId = `${config.workerId.slice(0, 56)}-${slot + 1}`;
  let cycles = 0;

  while (!signal.aborted) {
    cycles += 1;
    if (slot === 0 && cycles % 30 === 1) {
      try {
        const [reaped, expiredCandidates] = await Promise.all([
          reapExhaustedJobs(handle.sql, {
            leaseMs: config.leaseMs,
            queue: config.queue,
          }),
          deleteExpiredCandidateSets(handle.sql),
        ]);
        if (reaped > 0) logger.warn("exhausted_jobs_reaped", { count: reaped });
        if (expiredCandidates > 0) {
          logger.info("expired_candidate_sets_deleted", {
            count: expiredCandidates,
          });
        }
      } catch {
        logger.error("worker_maintenance_failed");
      }
    }

    let job: ClaimedJob | null;
    try {
      job = await claimNextJob(handle.sql, {
        leaseMs: config.leaseMs,
        queue: config.queue,
        workerId: slotId,
      });
    } catch {
      logger.error("job_claim_failed", { slot: slot + 1 });
      await abortableSleep(config.pollIntervalMs, signal);
      continue;
    }

    if (job) {
      logger.info("job_claimed", {
        attempt: job.attempts,
        jobId: job.id,
        slot: slot + 1,
        taskType: job.taskType,
      });
      await processJob(handle, job, handlers, config, logger, signal);
      continue;
    }

    await abortableSleep(config.pollIntervalMs, signal);
  }
}

export async function runWorker(input: {
  config: WorkerConfig;
  handle: DatabaseHandle;
  handlers: JobHandlers;
  logger: WorkerLogger;
  signal: AbortSignal;
}): Promise<void> {
  input.logger.info("worker_started", {
    concurrency: input.config.concurrency,
    queue: input.config.queue,
  });

  await Promise.all(
    Array.from({ length: input.config.concurrency }, (_, slot) =>
      runSlot(
        slot,
        input.handle,
        input.handlers,
        input.config,
        input.logger,
        input.signal,
      ),
    ),
  );

  input.logger.info("worker_stopped");
}
