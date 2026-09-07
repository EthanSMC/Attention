import type { ModerationRepositoryError } from "@attention/db";
import type { NextResponse } from "next/server";
import { noStoreJson } from "../../../../server/api-guard";

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
