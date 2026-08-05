import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { updateAccountProfile } from "../../../../server/account";
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

const MAX_PROFILE_BODY_BYTES = 512 * 1024;
const MAX_AVATAR_DATA_URL_CHARACTERS = 384 * 1024;

const bodySchema = z
  .object({
    avatar_url: z.string().max(MAX_AVATAR_DATA_URL_CHARACTERS).nullable().optional(),
    display_name: z.string().max(100).optional(),
  })
  .strict()
  .refine(
    (body) => body.display_name !== undefined || body.avatar_url !== undefined,
    { message: "empty_profile_update" },
  );

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestError = mutationRequestError(request, {
    maxContentLengthBytes: MAX_PROFILE_BODY_BYTES,
  });
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
    const profile = await updateAccountProfile(
      getWebDatabase(),
      requestSession.principal.accountId,
      {
        ...(body.display_name === undefined
          ? {}
          : { displayName: body.display_name }),
        ...(body.avatar_url === undefined ? {} : { avatarUrl: body.avatar_url }),
      },
    );
    return noStoreJson({
      avatar_url: profile.avatarUrl,
      display_name: profile.displayName,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof ZodError ||
      error instanceof RangeError
    ) {
      return noStoreJson({ error: { code: "invalid_profile" } }, { status: 400 });
    }
    console.error("profile_update_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
