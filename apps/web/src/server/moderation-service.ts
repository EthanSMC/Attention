import "server-only";

import {
  submitContentReport,
  type AttentionDatabase,
  type SubmitContentReportResult,
} from "@attention/db";

const DEFAULT_FILTER_REPORT_CASE_LIMIT_24H = 10;
const MAX_FILTER_REPORT_CASE_LIMIT_24H = 100;

export interface ReportPublicContentInput {
  details?: string | null;
  publicContentId: string;
  reasonCode: string;
}

export function filterReportCaseLimit(): number {
  const raw = process.env.ATTENTION_FILTER_REPORT_CASE_LIMIT_24H?.trim();
  if (!raw) return DEFAULT_FILTER_REPORT_CASE_LIMIT_24H;
  const configured = Number(raw);
  return Number.isSafeInteger(configured) && configured >= 1 &&
    configured <= MAX_FILTER_REPORT_CASE_LIMIT_24H
    ? configured
    : DEFAULT_FILTER_REPORT_CASE_LIMIT_24H;
}

/**
 * Shared moderation entrypoint for Web and Agent adapters. The repository
 * remains the source of truth for public visibility, duplicate reports,
 * thresholds, and the rolling Filter case-opening budget.
 */
export function reportPublicContent(
  db: AttentionDatabase,
  accountId: string,
  input: ReportPublicContentInput,
): Promise<SubmitContentReportResult> {
  return submitContentReport(db, {
    accountId,
    details: input.details ?? null,
    filterCaseOpenLimit: filterReportCaseLimit(),
    publicContentId: input.publicContentId,
    reasonCode: input.reasonCode,
  });
}
