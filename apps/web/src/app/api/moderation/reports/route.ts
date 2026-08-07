import {
  ModerationRepositoryError,
} from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import { reportPublicContent } from "../../../../server/moderation-service";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../server/request-body";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BODY_BYTES = 8_192;
const bodySchema = z
  .object({
    details: z.string().max(2000).nullable().optional(),
    public_content_id: z.string().uuid(),
    reason_code: z.string().min(1).max(64),
  })
  .strict();

export function moderationRepositoryErrorResponse(
  error: ModerationRepositoryError,
): NextResponse {
  const status =
    error.code === "report_rate_limited"
      ? 429
      : error.code === "content_not_reportable"
        ? 404
        : error.code === "account_not_active"
          ? 403
          : 400;
  const response = noStoreJson({ error: { code: error.code } }, { status });
  if (error.code === "report_rate_limited") {
    response.headers.set(
      "Retry-After",
      String(Math.max(1, error.retryAfterSeconds ?? 1)),
    );
  }
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_REPORT_BODY_BYTES),
    );
    const result = await reportPublicContent(
      getWebDatabase(),
      requestSession.principal.accountId,
      {
      details: body.details ?? null,
      publicContentId: body.public_content_id,
      reasonCode: body.reason_code,
      },
    );
    return noStoreJson({
      case_id: result.caseId,
      case_opened: result.caseOpened,
      community_status: result.communityStatus,
      duplicate: result.duplicate,
      report_id: result.reportId,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_report" } }, { status: 400 });
    }
    if (error instanceof ModerationRepositoryError) {
      return moderationRepositoryErrorResponse(error);
    }
    console.error("content_report_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
