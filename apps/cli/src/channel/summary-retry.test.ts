import { describe, expect, it } from "vitest";

import { defaultChannelState, type ChannelState } from "./state";
import {
  cancelSummaryRetry,
  deferSummaryRetryAfterDependency,
  markSummaryRetryRunning,
  nextDueSummaryRetry,
  scheduleSummaryRetry,
  settleSummaryRetryAttempt,
  summaryRetryContext,
} from "./summary-retry";

const COLLECTION_A = "11111111-1111-4111-8111-111111111111";
const COLLECTION_B = "22222222-2222-4222-8222-222222222222";

function at(iso: string): Date {
  return new Date(iso);
}

function requireJob(state: ChannelState, collectionId = COLLECTION_A) {
  const job = state.summaryRetries.find(
    (candidate) => candidate.collectionId === collectionId,
  );
  expect(job).toBeDefined();
  return job!;
}

describe("summary retry scheduling", () => {
  it("uses 2, 10, and 30 minute delays before pausing after attempt three", () => {
    const state = defaultChannelState();
    expect(
      scheduleSummaryRetry(
        state,
        COLLECTION_A,
        at("2026-09-04T08:00:00.000Z"),
      ),
    ).toBe("scheduled");
    expect(requireJob(state)).toMatchObject({
      automaticAttempts: 0,
      nextAttemptAt: "2026-09-04T08:02:00.000Z",
      status: "scheduled",
    });

    markSummaryRetryRunning(state, COLLECTION_A);
    expect(
      settleSummaryRetryAttempt(
        state,
        COLLECTION_A,
        "incomplete",
        at("2026-09-04T08:02:00.000Z"),
      ),
    ).toBe("scheduled");
    expect(requireJob(state)).toMatchObject({
      automaticAttempts: 1,
      nextAttemptAt: "2026-09-04T08:12:00.000Z",
    });

    markSummaryRetryRunning(state, COLLECTION_A);
    settleSummaryRetryAttempt(
      state,
      COLLECTION_A,
      "incomplete",
      at("2026-09-04T08:12:00.000Z"),
    );
    expect(requireJob(state)).toMatchObject({
      automaticAttempts: 2,
      nextAttemptAt: "2026-09-04T08:42:00.000Z",
    });

    markSummaryRetryRunning(state, COLLECTION_A);
    expect(
      settleSummaryRetryAttempt(
        state,
        COLLECTION_A,
        "incomplete",
        at("2026-09-04T08:42:00.000Z"),
      ),
    ).toBe("paused");
    expect(requireJob(state)).toMatchObject({
      automaticAttempts: 3,
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: null,
      status: "paused",
    });
  });

  it.each(["completed", "terminal"] as const)(
    "cancels a job after a %s result",
    (result) => {
      const state = defaultChannelState();
      scheduleSummaryRetry(state, COLLECTION_A, at("2026-09-04T08:00:00.000Z"));
      markSummaryRetryRunning(state, COLLECTION_A);
      expect(
        settleSummaryRetryAttempt(
          state,
          COLLECTION_A,
          result,
          at("2026-09-04T08:02:00.000Z"),
        ),
      ).toBe("cancelled");
      expect(state.summaryRetries).toEqual([]);
    },
  );

  it("defers dependency failures without consuming an automatic attempt", () => {
    const state = defaultChannelState();
    scheduleSummaryRetry(state, COLLECTION_A, at("2026-09-04T08:00:00.000Z"));
    markSummaryRetryRunning(state, COLLECTION_A);

    expect(
      deferSummaryRetryAfterDependency(
        state,
        COLLECTION_A,
        at("2026-09-04T08:03:00.000Z"),
      ),
    ).toBe(true);
    expect(requireJob(state)).toMatchObject({
      automaticAttempts: 0,
      lastFailureClass: null,
      nextAttemptAt: "2026-09-04T08:03:00.000Z",
      status: "scheduled",
    });
  });

  it("preserves an active automatic cycle after manual failure", () => {
    const state = defaultChannelState();
    scheduleSummaryRetry(state, COLLECTION_A, at("2026-09-04T08:00:00.000Z"));

    expect(
      scheduleSummaryRetry(
        state,
        COLLECTION_A,
        at("2026-09-04T08:01:00.000Z"),
      ),
    ).toBe("preserved");
    expect(requireJob(state)).toMatchObject({
      automaticAttempts: 0,
      cycleStartedAt: "2026-09-04T08:00:00.000Z",
      nextAttemptAt: "2026-09-04T08:02:00.000Z",
    });
  });

  it("starts a new cycle when manual failure follows a paused cycle", () => {
    const state = defaultChannelState();
    state.summaryRetries.push({
      automaticAttempts: 3,
      collectionId: COLLECTION_A,
      cycleStartedAt: "2026-09-04T07:00:00.000Z",
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: null,
      status: "paused",
    });

    expect(
      scheduleSummaryRetry(
        state,
        COLLECTION_A,
        at("2026-09-04T08:00:00.000Z"),
      ),
    ).toBe("scheduled");
    expect(requireJob(state)).toEqual({
      automaticAttempts: 0,
      collectionId: COLLECTION_A,
      cycleStartedAt: "2026-09-04T08:00:00.000Z",
      lastFailureClass: null,
      nextAttemptAt: "2026-09-04T08:02:00.000Z",
      status: "scheduled",
    });
  });

  it("returns the oldest due scheduled job and ignores paused jobs", () => {
    const state = defaultChannelState();
    scheduleSummaryRetry(state, COLLECTION_A, at("2026-09-04T08:01:00.000Z"));
    scheduleSummaryRetry(state, COLLECTION_B, at("2026-09-04T08:00:00.000Z"));
    expect(
      nextDueSummaryRetry(state, at("2026-09-04T08:02:30.000Z"))
        ?.collectionId,
    ).toBe(COLLECTION_B);
    cancelSummaryRetry(state, COLLECTION_B);
    expect(
      nextDueSummaryRetry(state, at("2026-09-04T08:02:30.000Z")),
    ).toBeNull();
  });

  it("evicts the oldest paused job when the 32 item queue is full", () => {
    const state = defaultChannelState();
    for (let index = 0; index < 32; index += 1) {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      state.summaryRetries.push({
        automaticAttempts: 3,
        collectionId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        cycleStartedAt: new Date(
          Date.UTC(2026, 8, 4, 7, index),
        ).toISOString(),
        lastFailureClass: "enrichment_incomplete",
        nextAttemptAt: null,
        status: "paused",
      });
    }

    expect(
      scheduleSummaryRetry(
        state,
        COLLECTION_A,
        at("2026-09-04T08:00:00.000Z"),
      ),
    ).toBe("scheduled");
    expect(state.summaryRetries).toHaveLength(32);
    expect(
      state.summaryRetries.some(
        (job) => job.collectionId === "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      ),
    ).toBe(false);
    expect(requireJob(state)).toBeDefined();
  });

  it("rejects a new job when 32 active jobs leave no paused eviction candidate", () => {
    const state = defaultChannelState();
    for (let index = 0; index < 32; index += 1) {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      scheduleSummaryRetry(
        state,
        `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        at("2026-09-04T08:00:00.000Z"),
      );
    }
    expect(
      scheduleSummaryRetry(
        state,
        COLLECTION_A,
        at("2026-09-04T08:00:00.000Z"),
      ),
    ).toBe("full");
    expect(state.summaryRetries).toHaveLength(32);
  });

  it("summarizes active, running, paused, and nearest retry without IDs", () => {
    const state = defaultChannelState();
    scheduleSummaryRetry(state, COLLECTION_A, at("2026-09-04T08:00:00.000Z"));
    scheduleSummaryRetry(state, COLLECTION_B, at("2026-09-04T08:01:00.000Z"));
    markSummaryRetryRunning(state, COLLECTION_B);
    state.summaryRetries.push({
      automaticAttempts: 3,
      collectionId: "33333333-3333-4333-8333-333333333333",
      cycleStartedAt: "2026-09-04T07:00:00.000Z",
      lastFailureClass: "enrichment_incomplete",
      nextAttemptAt: null,
      status: "paused",
    });

    expect(summaryRetryContext(state)).toEqual({
      active: 2,
      nextAttemptAt: "2026-09-04T08:02:00.000Z",
      paused: 1,
      running: 1,
    });
  });
});
