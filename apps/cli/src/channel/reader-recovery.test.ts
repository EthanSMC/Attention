import { describe, expect, it } from "vitest";
import { initialReaderBudget, readerRecoveryDecision } from "./reader-recovery";
import type { ReadAttemptControl } from "./read-attempt-control";

const control: ReadAttemptControl = {
  collectionId: "11111111-1111-4111-8111-111111111111", attemptRef: "r1",
  outcome: "failed", methods: ["static"], failureCode: "source_content_pending",
  failureScope: "source", recovery: "retry_later", retryAfterMs: null,
};
describe("finite reader recovery", () => {
  it.each([
    ["source_content_pending", "source"],
    ["unknown_reader_error", "reader"],
  ] as const)("honors Retry-After for %s without extending its recovery count", (failureCode, failureScope) => {
    const failure = { ...control, failureCode, failureScope, retryAfterMs: 600000 };
    const decision = readerRecoveryDecision(failure, initialReaderBudget(), 1000);
    expect(decision).toMatchObject({ action: "schedule", nextAttemptAt: 601000 });
    expect(decision.budget).toMatchObject({ contentRecoveries: failureScope === "source" ? 1 : 0, unknownRecoveries: failureScope === "reader" ? 1 : 0 });
  });
  it("honors contextual pause and verification without a second browser timer", () => {
    for (const recovery of ["pause", "needs_action", "switch_reader"] as const)
      expect(readerRecoveryDecision({ ...control, recovery }, initialReaderBudget(), 0))
        .toMatchObject({ action: "pause", nextAttemptAt: null });
  });
  it("allows content recovery at 2, 12, 42 minutes then pauses", () => {
    let budget = initialReaderBudget();
    for (const [now, next] of [[0, 120000], [120000, 720000], [720000, 2520000]] as const) {
      const decision = readerRecoveryDecision(control, budget, now);
      expect(decision).toMatchObject({ action: "schedule", nextAttemptAt: next });
      budget = decision.budget;
    }
    expect(readerRecoveryDecision(control, budget, 2520000).action).toBe("pause");
  });
  it("bounds dependency to initial plus four calls and 15 minutes", () => {
    const failure = { ...control, failureScope: "dependency" as const, failureCode: "fetcher_timeout" as const };
    let budget = initialReaderBudget();
    for (const [now, next] of [[0, 5000], [5000, 35000], [35000, 155000], [155000, 455000]] as const) {
      const d = readerRecoveryDecision(failure, budget, now);
      expect(d.nextAttemptAt).toBe(next); budget = d.budget;
    }
    expect(readerRecoveryDecision(failure, budget, 455000).action).toBe("pause");
    expect(readerRecoveryDecision(failure, { ...initialReaderBudget(), dependencyStartedAt: 0 }, 900000).action).toBe("pause");
  });
  it("honors rate deadline and keeps counters across category changes", () => {
    const d = readerRecoveryDecision({ ...control, failureCode: "rate_limited", failureScope: "dependency", retryAfterMs: 120000 }, initialReaderBudget(), 1000);
    expect(d.nextAttemptAt).toBe(121000);
    const unknown = { ...control, failureCode: "invalid_fetcher_response" as const };
    const u = readerRecoveryDecision(unknown, d.budget, 121000);
    expect(u.nextAttemptAt).toBe(241000);
    const content = readerRecoveryDecision(control, u.budget, 241000);
    expect(readerRecoveryDecision(unknown, content.budget, 361000).action).toBe("pause");
    expect(content.budget.dependencyStartedAt).toBe(1000);
  });
  it("ready reading does not complete summary submission", () => {
    expect(readerRecoveryDecision({ ...control, outcome: "ready", recovery: null, failureCode: null, failureScope: null }, initialReaderBudget(), 0).action).not.toBe("complete");
  });
});
