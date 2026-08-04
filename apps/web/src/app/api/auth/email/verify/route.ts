import { EmailAuthError, verifyLoginChallenge } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../server/request-body";
import { setSessionCookie } from "../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EMAIL_VERIFY_BODY_BYTES = 4_096;

const bodySchema = z
  .object({
    accept_terms: z.boolean(),
    challenge_id: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/u),
  })
  .strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestError = mutationRequestError(request);
  if (requestError) {
    return noStoreJson({ error: { code: requestError } }, { status: 400 });
  }

  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_EMAIL_VERIFY_BODY_BYTES),
    );
    const verified = await verifyLoginChallenge(getWebDatabase(), {
      acceptTerms: body.accept_terms,
      challengeId: body.challenge_id,
      code: body.code,
    });
    const response = noStoreJson({
      account: {
        created: verified.accountCreated,
        display_name: verified.displayName,
        stable_handle: verified.stableHandle,
      },
      redirect_to: verified.returnTo,
    });
    setSessionCookie(response, verified.session);
    return response;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson(
        { error: { code: "request_too_large" } },
        { status: 413 },
      );
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    if (error instanceof EmailAuthError) {
      const status = error.code === "account_unavailable" ? 403 : 400;
      return noStoreJson({ error: { code: error.code } }, { status });
    }
    console.error("email_login_verify_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
