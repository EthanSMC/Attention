import type { ChannelState, SummaryRetryJob } from "./state";
import { normalizeReadAttemptControl, type ReadAttemptControl } from "./read-attempt-control";
import { initialReaderBudget, readerCategory, readerRecoveryDecision, type ReaderCheckpoint } from "./reader-recovery";

export function ensureReaderCheckpoint(job: SummaryRetryJob): ReaderCheckpoint {
  return job.reader ??= { schemaVersion: 1, category: "unknown", budget: {
    ...initialReaderBudget(), contentRecoveries: Math.min(3, job.automaticAttempts + 1), sequence: job.automaticAttempts,
  } };
}

export function settleReaderAttempt(job: SummaryRetryJob, control: ReadAttemptControl, now: Date,
  options: {preserveActiveCycle?: boolean} = {}): "scheduled" | "paused" | "terminal" {
  const checkpoint = ensureReaderCheckpoint(job);
  checkpoint.category = readerCategory(control);
  const lastRead = normalizeReadAttemptControl(control);
  if (lastRead) checkpoint.lastRead = lastRead;
  delete checkpoint.interrupted;
  if (options.preserveActiveCycle && job.status !== "paused" &&
    (control.recovery === "retry_later" || control.outcome === "ready")) {
    // This is a manual observation, not consumption of the scheduled automatic attempt.
    const next = job.nextAttemptAt === null ? null : Math.max(Date.parse(job.nextAttemptAt), now.getTime() + (control.retryAfterMs ?? 0));
    const dependencyStart = checkpoint.budget.dependencyStartedAt;
    if (control.failureScope === "dependency" && dependencyStart !== null &&
      (now.getTime() >= dependencyStart + 900_000 || (next !== null && next >= dependencyStart + 900_000))) {
      job.status = "paused"; job.nextAttemptAt = null; return "paused";
    }
    if (next !== null && control.retryAfterMs !== null) job.nextAttemptAt = new Date(next).toISOString();
    return "scheduled";
  }
  const decision = readerRecoveryDecision(control, checkpoint.budget, now.getTime());
  checkpoint.budget = decision.budget;
  if (checkpoint.category === "content" && control.recovery === "retry_later") job.automaticAttempts = Math.max(0, decision.budget.contentRecoveries - (decision.action === "schedule" ? 1 : 0)) as 0 | 1 | 2 | 3;
  job.nextAttemptAt = decision.nextAttemptAt === null ? null : new Date(decision.nextAttemptAt).toISOString();
  job.status = decision.action === "schedule" ? "scheduled" : "paused";
  return decision.action === "stop" ? "terminal" : job.status;
}

export function unknownReadFailure(collectionId: string, attemptRef: string, dependency = false): ReadAttemptControl {
  return { collectionId, attemptRef, outcome: "failed", methods: null, failureCode: dependency ? "bridge_dependency_unavailable" : "unknown_reader_error", failureScope: dependency ? "dependency" : "reader", recovery: "retry_later", retryAfterMs: null };
}

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
  readonly readFacts?: readonly {
    collectionId: string;
    status: SummaryRetryJob["status"];
    nextAttemptAt: string | null;
    lastRead: ReadAttemptControl | null;
    interrupted: boolean;
  }[];
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
  options: { readonly manual?: boolean } = {},
): SummaryRetryScheduleResult {
  const existingIndex = retryIndex(state, collectionId);
  if (existingIndex >= 0) {
    const existing = state.summaryRetries[existingIndex];
    if (!existing || existing.status !== "paused" || !options.manual) return "preserved";
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
  const readFacts = state.summaryRetries.flatMap((job) => job.reader ? [{ collectionId: job.collectionId, status: job.status, nextAttemptAt: job.nextAttemptAt, lastRead: job.reader.lastRead ?? null, interrupted: job.reader.interrupted === true }] : []);
  return { active, nextAttemptAt, paused, running, ...(readFacts.length ? { readFacts } : {}) };
}
