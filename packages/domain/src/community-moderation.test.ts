import { describe, expect, it } from "vitest";

import {
  COURT_REVIEW_WINDOW_MS,
  resolveModerationCourt,
  shouldOpenModerationCase,
} from "./community-moderation";

const openedAt = new Date("2026-08-04T00:00:00.000Z");
const afterWindow = new Date(openedAt.getTime() + COURT_REVIEW_WINDOW_MS);

describe("community moderation", () => {
  it("opens a case for two distinct consumer reports", () => {
    expect(
      shouldOpenModerationCase({ distinctConsumerReports: 2, hasFilterReport: false }),
    ).toBe(true);
  });

  it("opens a case immediately for a filter report", () => {
    expect(
      shouldOpenModerationCase({ distinctConsumerReports: 0, hasFilterReport: true }),
    ).toBe(true);
  });

  it("keeps voting open for the full 24 hour window", () => {
    expect(
      resolveModerationCourt({
        eligibleFilterCount: 4,
        hiddenVotes: 0,
        openedAt,
        publicVotes: 4,
        resolveAt: new Date(afterWindow.getTime() - 1),
      }),
    ).toBe("pending");
  });

  it("resolves by simple majority after three votes and 24 hours", () => {
    expect(
      resolveModerationCourt({
        eligibleFilterCount: 5,
        hiddenVotes: 1,
        openedAt,
        publicVotes: 2,
        resolveAt: afterWindow,
      }),
    ).toBe("public");
  });

  it("requires an administrator for a tie or insufficient quorum", () => {
    expect(
      resolveModerationCourt({
        eligibleFilterCount: 4,
        hiddenVotes: 2,
        openedAt,
        publicVotes: 2,
        resolveAt: afterWindow,
      }),
    ).toBe("requires_admin");
    expect(
      resolveModerationCourt({
        eligibleFilterCount: 2,
        hiddenVotes: 2,
        openedAt,
        publicVotes: 0,
        resolveAt: afterWindow,
      }),
    ).toBe("requires_admin");
  });
});
