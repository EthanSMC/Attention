export type CommunityModerationStatus = "clear" | "hidden" | "pending_review";
export type ModerationDecision = "hidden" | "public";
export type CourtOutcome = ModerationDecision | "pending" | "requires_admin";

export interface ReportThresholdInput {
  distinctConsumerReports: number;
  hasFilterReport: boolean;
}

export interface CourtResolutionInput {
  eligibleFilterCount: number;
  hiddenVotes: number;
  openedAt: Date;
  publicVotes: number;
  resolveAt: Date;
}

export const COURT_MINIMUM_VOTES = 3;
export const COURT_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function shouldOpenModerationCase(input: ReportThresholdInput): boolean {
  if (!Number.isInteger(input.distinctConsumerReports) || input.distinctConsumerReports < 0) {
    throw new RangeError("distinctConsumerReports must be a non-negative integer");
  }
  return input.hasFilterReport || input.distinctConsumerReports >= 2;
}

export function resolveModerationCourt(input: CourtResolutionInput): CourtOutcome {
  const counts = [
    input.eligibleFilterCount,
    input.hiddenVotes,
    input.publicVotes,
  ];
  if (counts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new RangeError("court counts must be non-negative integers");
  }
  if (input.hiddenVotes + input.publicVotes > input.eligibleFilterCount) {
    throw new RangeError("votes cannot exceed eligible filters");
  }
  if (input.resolveAt.getTime() - input.openedAt.getTime() < COURT_REVIEW_WINDOW_MS) {
    return "pending";
  }

  const totalVotes = input.hiddenVotes + input.publicVotes;
  if (
    input.eligibleFilterCount < COURT_MINIMUM_VOTES ||
    totalVotes < COURT_MINIMUM_VOTES ||
    input.hiddenVotes === input.publicVotes
  ) {
    return "requires_admin";
  }

  return input.publicVotes > input.hiddenVotes ? "public" : "hidden";
}
