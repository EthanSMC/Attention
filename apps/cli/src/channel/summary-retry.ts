import type { ChannelState, SummaryRetryJob } from "./state";

export const SUMMARY_RETRY_DELAYS_MS = [
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;

export type SummaryRetryAttemptResult =
  | "completed"
  | "dependency_failure"
  | "incomplete"
  | "terminal";

export interface SummaryRetryContext {
  readonly active: number;
  readonly nextAttemptAt: string | null;
  readonly paused: number;
  readonly running: number;
}

export type SummaryRetryScheduleResult =
  | "full"
  | "preserved"
  | "scheduled";

function nextTimestamp(now: Date, delayMs: number): string {
  return new Date(now.getTime() + delayMs).toISOString();
}

function retryIndex(
  state: ChannelState,
  collectionId: string,
): number {
  return state.summaryRetries.findIndex(
    (job) => job.collectionId === collectionId,
  );
}

export function scheduleSummaryRetry(
  state: ChannelState,
  collectionId: string,
  now: Date,
): SummaryRetryScheduleResult {
  const existingIndex = retryIndex(state, collectionId);
  if (existingIndex >= 0) {
    const existing = state.summaryRetries[existingIndex];
    if (!existing || existing.status !== "paused") return "preserved";
    state.summaryRetries[existingIndex] = {
      automaticAttempts: 0,
      collectionId,
      cycleStartedAt: now.toISOString(),
      lastFailureClass: null,
      nextAttemptAt: nextTimestamp(now, SUMMARY_RETRY_DELAYS_MS[0]),
      status: "scheduled",
    };
    return "scheduled";
  }

  if (state.summaryRetries.length >= 32) {
    let oldestPausedIndex = -1;
    let oldestPausedAt = Number.POSITIVE_INFINITY;
    for (const [index, job] of state.summaryRetries.entries()) {
      if (job.status !== "paused") continue;
      const cycleStartedAt = Date.parse(job.cycleStartedAt);
      if (cycleStartedAt < oldestPausedAt) {
        oldestPausedAt = cycleStartedAt;
        oldestPausedIndex = index;
      }
    }
    if (oldestPausedIndex < 0) return "full";
    state.summaryRetries.splice(oldestPausedIndex, 1);
  }

  state.summaryRetries.push({
    automaticAttempts: 0,
    collectionId,
    cycleStartedAt: now.toISOString(),
    lastFailureClass: null,
    nextAttemptAt: nextTimestamp(now, SUMMARY_RETRY_DELAYS_MS[0]),
    status: "scheduled",
  });
  return "scheduled";
}

export function cancelSummaryRetry(
  state: ChannelState,
  collectionId: string,
): boolean {
  const index = retryIndex(state, collectionId);
  if (index < 0) return false;
  state.summaryRetries.splice(index, 1);
  return true;
}

export function markSummaryRetryRunning(
  state: ChannelState,
  collectionId: string,
): SummaryRetryJob | null {
  const job = state.summaryRetries[retryIndex(state, collectionId)];
  if (!job || job.status !== "scheduled") return null;
  job.status = "running";
  return job;
}

export function deferSummaryRetryAfterDependency(
  state: ChannelState,
  collectionId: string,
  retryAt: Date,
): boolean {
  const job = state.summaryRetries[retryIndex(state, collectionId)];
  if (!job) return false;
  job.nextAttemptAt = retryAt.toISOString();
  job.status = "scheduled";
  return true;
}

export function settleSummaryRetryAttempt(
  state: ChannelState,
  collectionId: string,
  result: SummaryRetryAttemptResult,
  now: Date,
): "cancelled" | "paused" | "scheduled" {
  if (result === "completed" || result === "terminal") {
    cancelSummaryRetry(state, collectionId);
    return "cancelled";
  }
  const job = state.summaryRetries[retryIndex(state, collectionId)];
  if (!job) return "cancelled";
  if (result === "dependency_failure") {
    job.nextAttemptAt = now.toISOString();
    job.status = "scheduled";
    return "scheduled";
  }

  const automaticAttempts = Math.min(3, job.automaticAttempts + 1) as
    | 1
    | 2
    | 3;
  job.automaticAttempts = automaticAttempts;
  job.lastFailureClass = "enrichment_incomplete";
  if (automaticAttempts === 3) {
    job.nextAttemptAt = null;
    job.status = "paused";
    return "paused";
  }
  job.nextAttemptAt = nextTimestamp(
    now,
    SUMMARY_RETRY_DELAYS_MS[automaticAttempts],
  );
  job.status = "scheduled";
  return "scheduled";
}

export function nextDueSummaryRetry(
  state: ChannelState,
  now: Date,
): SummaryRetryJob | null {
  const nowMs = now.getTime();
  let earliest: SummaryRetryJob | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const job of state.summaryRetries) {
    if (job.status !== "scheduled" || !job.nextAttemptAt) continue;
    const dueAt = Date.parse(job.nextAttemptAt);
    if (dueAt <= nowMs && dueAt < earliestMs) {
      earliest = job;
      earliestMs = dueAt;
    }
  }
  return earliest;
}

export function summaryRetryContext(state: ChannelState): SummaryRetryContext {
  let active = 0;
  let paused = 0;
  let running = 0;
  let nextAttemptAt: string | null = null;
  for (const job of state.summaryRetries) {
    if (job.status === "paused") {
      paused += 1;
      continue;
    }
    active += 1;
    if (job.status === "running") running += 1;
    if (
      job.status === "scheduled" &&
      job.nextAttemptAt &&
      (!nextAttemptAt ||
        Date.parse(job.nextAttemptAt) < Date.parse(nextAttemptAt))
    ) {
      nextAttemptAt = job.nextAttemptAt;
    }
  }
  return { active, nextAttemptAt, paused, running };
}
