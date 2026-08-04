import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { updateDisplayName } from "../../../../server/account";
import { getWebDatabase } from "../../../../server/db";
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

const MAX_PROFILE_BODY_BYTES = 8_192;

const bodySchema = z.object({ display_name: z.string().max(100) }).strict();

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestError = mutationRequestError(request);
  if (requestError) return noStoreJson({ error: { code: requestError } }, { status: 400 });
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
      await readJsonRequestWithinLimit(request, MAX_PROFILE_BODY_BYTES),
    );
    const displayName = await updateDisplayName(
      getWebDatabase(),
      requestSession.principal.accountId,
      body.display_name,
    );
    return noStoreJson({ display_name: displayName });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof ZodError ||
      error instanceof RangeError
    ) {
      return noStoreJson({ error: { code: "invalid_display_name" } }, { status: 400 });
    }
    console.error("profile_update_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
