import {
  COURT_REVIEW_WINDOW_MS,
  resolveModerationCourt,
  shouldOpenModerationCase,
  type ModerationDecision,
} from "@attention/domain";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";

import type { AttentionDatabase, AttentionTransaction } from "../client";
import {
  accounts,
  contentReports,
  contents,
  filterProfiles,
  moderationCases,
  moderationVotes,
} from "../schema";

export type ModerationRepositoryErrorCode =
  | "account_not_active"
  | "case_not_found"
  | "case_not_open"
  | "content_not_reportable"
  | "filter_required"
  | "invalid_report"
  | "vote_already_cast"
  | "voting_closed";

export class ModerationRepositoryError extends Error {
  constructor(readonly code: ModerationRepositoryErrorCode) {
    super(code);
    this.name = "ModerationRepositoryError";
  }
}

const REPORT_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

async function setAccountContext(
  tx: AttentionTransaction,
  accountId: string,
): Promise<void> {
  await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
}

async function lockModerationCase(
  tx: AttentionTransaction,
  caseId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${caseId}::text, 0))`,
  );
}

async function activeFilter(
  tx: AttentionTransaction,
  accountId: string,
): Promise<boolean> {
  const [filter] = await tx
    .select({ accountId: filterProfiles.accountId })
    .from(filterProfiles)
    .innerJoin(accounts, eq(accounts.id, filterProfiles.accountId))
    .where(
      and(
        eq(filterProfiles.accountId, accountId),
        eq(filterProfiles.active, true),
        isNull(filterProfiles.revokedAt),
        eq(accounts.status, "active"),
      ),
    )
    .limit(1);
  return Boolean(filter);
}

async function requireActiveAccount(
  tx: AttentionTransaction,
  accountId: string,
): Promise<void> {
  const [account] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.status, "active")))
    .limit(1);
  if (!account) throw new ModerationRepositoryError("account_not_active");
}

export interface SubmitContentReportResult {
  caseId: string | null;
  caseOpened: boolean;
  communityStatus: "clear" | "hidden" | "pending_review";
  duplicate: boolean;
  reportId: string;
}

export async function submitContentReport(
  db: AttentionDatabase,
  input: {
    accountId: string;
    details?: string | null;
    now?: Date;
    publicContentId: string;
    reasonCode: string;
  },
): Promise<SubmitContentReportResult> {
  const now = input.now ?? new Date();
  const reasonCode = input.reasonCode.trim().toLowerCase();
  const details = input.details?.normalize("NFKC").trim() || null;
  if (
    !REPORT_REASON_PATTERN.test(reasonCode) ||
    (details !== null && details.length > 2000)
  ) {
    throw new ModerationRepositoryError("invalid_report");
  }

  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveAccount(tx, input.accountId);
    const reporterIsFilter = await activeFilter(tx, input.accountId);
    const [content] = await tx
      .select({
        communityStatus: contents.communityModerationStatus,
        contentStatus: contents.contentStatus,
        firstPublicAt: contents.firstPublicAt,
        id: contents.id,
        publicSafetyStatus: contents.publicSafetyStatus,
        takedownStatus: contents.takedownStatus,
        visibilityVersion: contents.visibilityVersion,
      })
      .from(contents)
      .where(eq(contents.publicId, input.publicContentId))
      .for("update")
      .limit(1);
    if (
      !content ||
      content.firstPublicAt === null ||
      content.contentStatus !== "active" ||
      content.publicSafetyStatus !== "allowed" ||
      content.takedownStatus !== "none"
    ) {
      throw new ModerationRepositoryError("content_not_reportable");
    }

    const [existing] = await tx
      .select({ id: contentReports.id })
      .from(contentReports)
      .where(
        and(
          eq(contentReports.contentId, content.id),
          eq(contentReports.reporterAccountId, input.accountId),
        ),
      )
      .limit(1);
    const [activeCaseBefore] = await tx
      .select({ id: moderationCases.id })
      .from(moderationCases)
      .where(
        and(
          eq(moderationCases.contentId, content.id),
          inArray(moderationCases.status, ["open", "requires_admin"]),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        caseId: activeCaseBefore?.id ?? null,
        caseOpened: false,
        communityStatus: content.communityStatus,
        duplicate: true,
        reportId: existing.id,
      };
    }

    const [report] = await tx
      .insert(contentReports)
      .values({
        contentId: content.id,
        details,
        reasonCode,
        reporterAccountId: input.accountId,
        reporterKind: reporterIsFilter ? "filter" : "consumer",
        createdAt: now,
      })
      .returning({ id: contentReports.id });
    if (!report) throw new Error("content_report_insert_failed");

    const [threshold] = await tx
      .select({
        consumerReports: count(
          sql`CASE WHEN ${contentReports.reporterKind} = 'consumer' THEN 1 END`,
        ),
        filterReports: count(
          sql`CASE WHEN ${contentReports.reporterKind} = 'filter' THEN 1 END`,
        ),
      })
      .from(contentReports)
      .where(eq(contentReports.contentId, content.id));
    const consumerReports = threshold?.consumerReports ?? 0;
    const hasFilterReport = (threshold?.filterReports ?? 0) > 0;
    const shouldOpen = shouldOpenModerationCase({
      distinctConsumerReports: consumerReports,
      hasFilterReport,
    });
    if (
      !shouldOpen ||
      content.communityStatus !== "clear" ||
      activeCaseBefore
    ) {
      return {
        caseId: activeCaseBefore?.id ?? null,
        caseOpened: false,
        communityStatus: content.communityStatus,
        duplicate: false,
        reportId: report.id,
      };
    }

    const nextVisibilityVersion = content.visibilityVersion + 1;
    await tx
      .update(contents)
      .set({
        communityModerationStatus: "pending_review",
        updatedAt: now,
        visibilityVersion: nextVisibilityVersion,
      })
      .where(eq(contents.id, content.id));
    const [moderationCase] = await tx
      .insert(moderationCases)
      .values({
        consumerReportCountAtOpen: consumerReports,
        contentId: content.id,
        hasFilterReportAtOpen: hasFilterReport,
        openedAt: now,
        openedByReportId: report.id,
        updatedAt: now,
        visibilityVersionAtOpen: nextVisibilityVersion,
        votingEndsAt: new Date(now.getTime() + COURT_REVIEW_WINDOW_MS),
      })
      .returning({ id: moderationCases.id });
    if (!moderationCase) throw new Error("moderation_case_insert_failed");
    return {
      caseId: moderationCase.id,
      caseOpened: true,
      communityStatus: "pending_review",
      duplicate: false,
      reportId: report.id,
    };
  });
}

export interface ModerationCourtCase {
  author: string | null;
  communityStatus: "clear" | "hidden" | "pending_review";
  eligibleFilterCount: number;
  hiddenVotes: number;
  id: string;
  myVote: ModerationDecision | null;
  openedAt: Date;
  outboundHref: string | null;
  publicContentId: string;
  publicVotes: number;
  source: string;
  status: "open" | "requires_admin";
  title: string | null;
  votingEndsAt: Date;
}

async function requireActiveFilter(
  tx: AttentionTransaction,
  accountId: string,
): Promise<void> {
  if (!(await activeFilter(tx, accountId))) {
    throw new ModerationRepositoryError("filter_required");
  }
}

export async function castModerationVote(
  db: AttentionDatabase,
  input: {
    accountId: string;
    caseId: string;
    decision: ModerationDecision;
    now?: Date;
  },
): Promise<{ duplicate: boolean; voteId: string }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveFilter(tx, input.accountId);
    await lockModerationCase(tx, input.caseId);
    const [moderationCase] = await tx
      .select({
        status: moderationCases.status,
        votingEndsAt: moderationCases.votingEndsAt,
      })
      .from(moderationCases)
      .where(eq(moderationCases.id, input.caseId))
      .limit(1);
    if (!moderationCase) throw new ModerationRepositoryError("case_not_found");
    if (moderationCase.status !== "open") {
      throw new ModerationRepositoryError("case_not_open");
    }
    if (now >= moderationCase.votingEndsAt) {
      throw new ModerationRepositoryError("voting_closed");
    }

    const [existing] = await tx
      .select({ decision: moderationVotes.decision, id: moderationVotes.id })
      .from(moderationVotes)
      .where(
        and(
          eq(moderationVotes.caseId, input.caseId),
          eq(moderationVotes.filterAccountId, input.accountId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.decision !== input.decision) {
        throw new ModerationRepositoryError("vote_already_cast");
      }
      return { duplicate: true, voteId: existing.id };
    }
    const [vote] = await tx
      .insert(moderationVotes)
      .values({
        caseId: input.caseId,
        createdAt: now,
        decision: input.decision,
        filterAccountId: input.accountId,
      })
      .onConflictDoNothing({
        target: [moderationVotes.caseId, moderationVotes.filterAccountId],
      })
      .returning({ id: moderationVotes.id });
    if (vote) return { duplicate: false, voteId: vote.id };

    const [racedVote] = await tx
      .select({ decision: moderationVotes.decision, id: moderationVotes.id })
      .from(moderationVotes)
      .where(
        and(
          eq(moderationVotes.caseId, input.caseId),
          eq(moderationVotes.filterAccountId, input.accountId),
        ),
      )
      .limit(1);
    if (!racedVote) throw new Error("moderation_vote_insert_failed");
    if (racedVote.decision !== input.decision) {
      throw new ModerationRepositoryError("vote_already_cast");
    }
    return { duplicate: true, voteId: racedVote.id };
  });
}

async function currentCourtCounts(
  tx: AttentionTransaction,
  caseId: string,
): Promise<{
  eligibleFilterCount: number;
  hiddenVotes: number;
  publicVotes: number;
}> {
  const [eligible] = await tx
    .select({ value: count() })
    .from(filterProfiles)
    .innerJoin(accounts, eq(accounts.id, filterProfiles.accountId))
    .where(
      and(
        eq(filterProfiles.active, true),
        isNull(filterProfiles.revokedAt),
        eq(accounts.status, "active"),
      ),
    );
  const [votes] = await tx
    .select({
      hidden: count(
        sql`CASE WHEN ${moderationVotes.decision} = 'hidden' THEN 1 END`,
      ),
      public: count(
        sql`CASE WHEN ${moderationVotes.decision} = 'public' THEN 1 END`,
      ),
    })
    .from(moderationVotes)
    .innerJoin(filterProfiles, eq(filterProfiles.accountId, moderationVotes.filterAccountId))
    .innerJoin(accounts, eq(accounts.id, moderationVotes.filterAccountId))
    .where(
      and(
        eq(moderationVotes.caseId, caseId),
        eq(filterProfiles.active, true),
        isNull(filterProfiles.revokedAt),
        eq(accounts.status, "active"),
      ),
    );
  return {
    eligibleFilterCount: eligible?.value ?? 0,
    hiddenVotes: votes?.hidden ?? 0,
    publicVotes: votes?.public ?? 0,
  };
}

export async function resolveDueModerationCases(
  db: AttentionDatabase,
  input: { limit?: number; now?: Date } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit must be between 1 and 500");
  }
  const due = await db
    .select({ id: moderationCases.id })
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.status, "open"),
        lte(moderationCases.votingEndsAt, now),
      ),
    )
    .orderBy(asc(moderationCases.votingEndsAt))
    .limit(limit);
  let resolved = 0;
  for (const candidate of due) {
    const changed = await db.transaction(async (tx) => {
      await lockModerationCase(tx, candidate.id);
      const [moderationCase] = await tx
        .select({
          contentId: moderationCases.contentId,
          openedAt: moderationCases.openedAt,
          status: moderationCases.status,
          votingEndsAt: moderationCases.votingEndsAt,
        })
        .from(moderationCases)
        .where(eq(moderationCases.id, candidate.id))
        .for("update")
        .limit(1);
      if (
        !moderationCase ||
        moderationCase.status !== "open" ||
        moderationCase.votingEndsAt > now
      ) {
        return false;
      }
      const counts = await currentCourtCounts(tx, candidate.id);
      let outcome = resolveModerationCourt({
        ...counts,
        openedAt: moderationCase.openedAt,
        resolveAt: now,
      });
      if (outcome === "pending") return false;

      const [content] = await tx
        .select({
          communityStatus: contents.communityModerationStatus,
          contentStatus: contents.contentStatus,
          publicSafetyStatus: contents.publicSafetyStatus,
          takedownStatus: contents.takedownStatus,
          visibilityVersion: contents.visibilityVersion,
        })
        .from(contents)
        .where(eq(contents.id, moderationCase.contentId))
        .for("update")
        .limit(1);
      if (!content) return false;
      const hardEligible =
        content.contentStatus === "active" &&
        content.publicSafetyStatus === "allowed" &&
        content.takedownStatus === "none";
      if (
        outcome === "public" &&
        (!hardEligible || content.communityStatus !== "pending_review")
      ) {
        outcome = "requires_admin";
      }
      const nextCommunityStatus =
        outcome === "public"
          ? "clear"
          : outcome === "hidden"
            ? "hidden"
            : content.communityStatus;
      const nextVisibilityVersion = content.visibilityVersion + 1;
      await tx
        .update(contents)
        .set({
          communityModerationStatus: nextCommunityStatus,
          updatedAt: now,
          visibilityVersion: nextVisibilityVersion,
        })
        .where(eq(contents.id, moderationCase.contentId));
      await tx
        .update(moderationCases)
        .set({
          eligibleFilterCountAtResolution: counts.eligibleFilterCount,
          hiddenVotesAtResolution: counts.hiddenVotes,
          publicVotesAtResolution: counts.publicVotes,
          resolution: outcome,
          resolvedAt: now,
          status: outcome === "requires_admin" ? "requires_admin" : "resolved",
          updatedAt: now,
          visibilityVersionAtResolution: nextVisibilityVersion,
        })
        .where(eq(moderationCases.id, candidate.id));
      return true;
    });
    if (changed) resolved += 1;
  }
  return resolved;
}

export async function listModerationCourtCases(
  db: AttentionDatabase,
  input: { accountId: string; now?: Date },
): Promise<ModerationCourtCase[]> {
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveFilter(tx, input.accountId);
    const rows = await tx
      .select({
        author: contents.author,
        communityStatus: contents.communityModerationStatus,
        id: moderationCases.id,
        openedAt: moderationCases.openedAt,
        publicContentId: contents.publicId,
        contentStatus: contents.contentStatus,
        publicSafetyStatus: contents.publicSafetyStatus,
        source: contents.source,
        status: moderationCases.status,
        title: contents.title,
        takedownStatus: contents.takedownStatus,
        votingEndsAt: moderationCases.votingEndsAt,
      })
      .from(moderationCases)
      .innerJoin(contents, eq(contents.id, moderationCases.contentId))
      .where(inArray(moderationCases.status, ["open", "requires_admin"]))
      .orderBy(asc(moderationCases.votingEndsAt));
    const result: ModerationCourtCase[] = [];
    for (const row of rows) {
      const counts = await currentCourtCounts(tx, row.id);
      const [myVote] = await tx
        .select({ decision: moderationVotes.decision })
        .from(moderationVotes)
        .where(
          and(
            eq(moderationVotes.caseId, row.id),
            eq(moderationVotes.filterAccountId, input.accountId),
          ),
        )
        .limit(1);
      result.push({
        author: row.author,
        communityStatus: row.communityStatus,
        ...counts,
        id: row.id,
        myVote: myVote?.decision ?? null,
        openedAt: row.openedAt,
        outboundHref:
          row.contentStatus === "active" &&
          row.publicSafetyStatus === "allowed" &&
          row.takedownStatus === "none"
            ? `/out/court/${row.id}`
            : null,
        publicContentId: row.publicContentId,
        source: row.source,
        status: row.status as "open" | "requires_admin",
        title: row.title,
        votingEndsAt: row.votingEndsAt,
      });
    }
    return result;
  });
}

export async function findModerationCourtOutboundUrl(
  db: AttentionDatabase,
  input: { accountId: string; caseId: string },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveFilter(tx, input.accountId);
    const [row] = await tx
      .select({ outboundUrl: contents.outboundUrl })
      .from(moderationCases)
      .innerJoin(contents, eq(contents.id, moderationCases.contentId))
      .where(
        and(
          eq(moderationCases.id, input.caseId),
          inArray(moderationCases.status, ["open", "requires_admin"]),
          eq(contents.contentStatus, "active"),
          eq(contents.publicSafetyStatus, "allowed"),
          eq(contents.takedownStatus, "none"),
        ),
      )
      .limit(1);
    return row?.outboundUrl ?? null;
  });
}
