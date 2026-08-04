import {
  castModerationVote,
  ModerationRepositoryError,
} from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../../server/request-body";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VOTE_BODY_BYTES = 4_096;

const paramsSchema = z.object({ caseId: z.string().uuid() });
const bodySchema = z.object({ decision: z.enum(["public", "hidden"]) }).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ caseId: string }> },
): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) {
    return noStoreJson({ error: { code: guardError } }, { status: 400 });
  }
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
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_VOTE_BODY_BYTES),
    );
    const result = await castModerationVote(getWebDatabase(), {
      accountId: requestSession.principal.accountId,
      caseId: params.caseId,
      decision: body.decision,
    });
    return noStoreJson({ duplicate: result.duplicate, vote_id: result.voteId });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_vote" } }, { status: 400 });
    }
    if (error instanceof ModerationRepositoryError) {
      const status =
        error.code === "filter_required"
          ? 403
          : error.code === "case_not_found"
            ? 404
            : error.code === "vote_already_cast"
              ? 409
              : 400;
      return noStoreJson({ error: { code: error.code } }, { status });
    }
    console.error("moderation_vote_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
