import { normalizeReadAttemptControl, type ReadAttemptControl } from "./read-attempt-control";
export interface ReaderBudget {
  contentRecoveries: number;
  dependencyRecoveries: number;
  dependencyStartedAt: number | null;
  unknownRecoveries: number;
  sequence: number;
}
export interface ReaderCheckpoint {
  schemaVersion: 1;
  category: "content" | "dependency" | "unknown";
  budget: ReaderBudget;
  lastRead?: ReadAttemptControl;
  interrupted?: true;
}

/** Strict, content-free on-disk schema; unknown fields never cross persistence. */
export function normalizeReaderCheckpoint(value: unknown): ReaderCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((key) => !["budget", "category", "schemaVersion", "lastRead", "interrupted"].includes(key)) || r.schemaVersion !== 1 || !["content", "dependency", "unknown"].includes(String(r.category))) return null;
  const lastRead = r.lastRead === undefined ? undefined : normalizeReadAttemptControl(r.lastRead);
  if (lastRead === null || (r.interrupted !== undefined && r.interrupted !== true)) return null;
  if (!r.budget || typeof r.budget !== "object" || Array.isArray(r.budget)) return null;
  const b = r.budget as Record<string, unknown>;
  if (Object.keys(b).sort().join() !== "contentRecoveries,dependencyRecoveries,dependencyStartedAt,sequence,unknownRecoveries") return null;
  for (const [key, max] of [["contentRecoveries", 3], ["dependencyRecoveries", 4], ["unknownRecoveries", 1], ["sequence", Number.MAX_SAFE_INTEGER]] as const) {
    if (typeof b[key] !== "number" || !Number.isSafeInteger(b[key]) || b[key] < 0 || b[key] > max) return null;
  }
  if (b.dependencyStartedAt !== null && (typeof b.dependencyStartedAt !== "number" || !Number.isSafeInteger(b.dependencyStartedAt) || b.dependencyStartedAt < 0)) return null;
  return { schemaVersion: 1, category: r.category as ReaderCheckpoint["category"], budget: { ...b } as unknown as ReaderBudget, ...(lastRead ? { lastRead } : {}), ...(r.interrupted ? { interrupted: true } : {}) };
}

export function readerCategory(control: ReadAttemptControl): ReaderCheckpoint["category"] {
  return control.failureScope === "dependency" ? "dependency" : control.outcome === "ready" || control.failureCode === "unknown_reader_error" || control.failureCode === "invalid_fetcher_response" ? "unknown" : "content";
}
export function initialReaderBudget(): ReaderBudget {
  return { contentRecoveries: 0, dependencyRecoveries: 0, dependencyStartedAt: null, unknownRecoveries: 0, sequence: 0 };
}
export function readerRecoveryDecision(control: ReadAttemptControl, previous: ReaderBudget, now: number): { action: "schedule" | "pause" | "stop" | "complete"; nextAttemptAt: number | null; budget: ReaderBudget } {
  const budget = { ...previous };
  const pause = { action: "pause", nextAttemptAt: null, budget } as const;
  if (control.recovery === "stop") return { ...pause, action: "stop" };
  if (control.recovery !== "retry_later" && control.outcome !== "ready") return pause;
  let delay: number;
  if (control.failureScope === "dependency") {
    budget.dependencyStartedAt ??= now;
    if (budget.dependencyRecoveries >= 4 || now - budget.dependencyStartedAt >= 900000) return pause;
    delay = [5000, 30000, 120000, 300000][budget.dependencyRecoveries++]!;
  } else if (control.failureCode === "unknown_reader_error" || control.failureCode === "invalid_fetcher_response" || control.outcome === "ready") {
    if (budget.unknownRecoveries >= 1) return pause;
    budget.unknownRecoveries++; delay = 120000;
  } else {
    if (budget.contentRecoveries >= 3) return pause;
    delay = [120000, 600000, 1800000][budget.contentRecoveries++]!;
  }
  delay = Math.max(delay, control.retryAfterMs ?? 0);
  if (control.failureScope === "dependency" && now + delay >= budget.dependencyStartedAt! + 900000) return pause;
  return { action: "schedule", nextAttemptAt: now + delay, budget };
}
