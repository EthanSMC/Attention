import {
  fingerprintLoginRequester,
  loginWithPassword,
  PasswordAuthError,
} from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../server/request-body";
import { setSessionCookie } from "../../../../server/session";
import {
  trustedClientSource,
  TrustedClientSourceError,
} from "../../../../server/trusted-client-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PASSWORD_LOGIN_BODY_BYTES = 8_192;

const bodySchema = z
  .object({
    email: z.string().max(320),
    password: z.string().max(128),
    return_to: z.string().max(2048).optional(),
  })
  .strict();

function requesterFingerprint(request: NextRequest): string {
  return fingerprintLoginRequester(trustedClientSource(request));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestError = mutationRequestError(request);
  if (requestError) {
    return noStoreJson({ error: { code: requestError } }, { status: 400 });
  }

  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_PASSWORD_LOGIN_BODY_BYTES),
    );
    const result = await loginWithPassword(getWebDatabase(), {
      email: body.email,
      password: body.password,
      requesterFingerprint: requesterFingerprint(request),
      ...(body.return_to ? { returnTo: body.return_to } : {}),
    });
    const response = noStoreJson({
      account: {
        display_name: result.displayName,
        stable_handle: result.stableHandle,
      },
      redirect_to: result.returnTo,
    });
    setSessionCookie(response, result.session);
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
    if (error instanceof PasswordAuthError) {
      const status = error.code === "rate_limited"
        ? 429
        : error.code === "account_unavailable"
          ? 403
          : 401;
      return noStoreJson({ error: { code: error.code } }, { status });
    }
    if (error instanceof TrustedClientSourceError) {
      console.error("trusted_client_source_unavailable", { route: "password_login" });
      return noStoreJson({ error: { code: "service_unavailable" } }, { status: 503 });
    }
    console.error("password_login_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
