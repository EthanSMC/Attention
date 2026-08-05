import {
  listModerationCourtCases,
  ModerationRepositoryError,
} from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestSession = await getRequestSession(request);
  if (!requestSession.principal) {
    const response = noStoreJson(
      { error: { code: "authentication_required" } },
      { status: 401 },
    );
    clearInvalidSessionCookie(response, requestSession);
    return response;
  }
  try {
    const cases = await listModerationCourtCases(getWebDatabase(), {
      accountId: requestSession.principal.accountId,
    });
    return noStoreJson({
      cases: cases.map((item) => ({
        author: item.author,
        community_status: item.communityStatus,
        eligible_filter_count: item.eligibleFilterCount,
        hidden_votes: item.hiddenVotes,
        id: item.id,
        my_vote: item.myVote,
        opened_at: item.openedAt.toISOString(),
        outbound_href: item.outboundHref,
        public_content_id: item.publicContentId,
        public_votes: item.publicVotes,
        source: item.source,
        status: item.status,
        title: item.title,
        voting_ends_at: item.votingEndsAt.toISOString(),
      })),
    });
  } catch (error) {
    if (
      error instanceof ModerationRepositoryError &&
      error.code === "filter_required"
    ) {
      return noStoreJson({ error: { code: error.code } }, { status: 403 });
    }
    console.error("moderation_cases_load_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
