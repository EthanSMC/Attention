import {
  cancelLoginChallenge,
  createLoginChallenge,
  EmailAuthError,
  fingerprintLoginRequester,
} from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../server/db";
import {
  getEmailOtpSender,
  mayExposeDevelopmentOtp,
} from "../../../../../server/email-otp";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../server/request-body";
import {
  trustedClientSource,
  TrustedClientSourceError,
} from "../../../../../server/trusted-client-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EMAIL_START_BODY_BYTES = 8_192;

const bodySchema = z
  .object({
    consumer_invite_token: z.string().min(32).max(256).optional(),
    email: z.string().max(320),
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
      await readJsonRequestWithinLimit(request, MAX_EMAIL_START_BODY_BYTES),
    );
    const challenge = await createLoginChallenge(getWebDatabase(), {
      email: body.email,
      requesterFingerprint: requesterFingerprint(request),
      ...(body.consumer_invite_token
        ? { consumerInviteToken: body.consumer_invite_token }
        : {}),
      ...(body.return_to ? { returnTo: body.return_to } : {}),
    });
    try {
      await getEmailOtpSender().send(challenge);
    } catch (error) {
      await cancelLoginChallenge(getWebDatabase(), challenge.challengeId);
      console.error("email_otp_delivery_failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return noStoreJson(
        { error: { code: "email_delivery_unavailable" } },
        { status: 503 },
      );
    }

    return noStoreJson({
      challenge_id: challenge.challengeId,
      expires_at: challenge.expiresAt.toISOString(),
      retry_after_seconds: challenge.retryAfterSeconds,
      ...(mayExposeDevelopmentOtp() ? { development_code: challenge.code } : {}),
    });
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
      const status = error.code === "rate_limited" ? 429 : 400;
      return noStoreJson(
        {
          error: {
            code: error.code,
            ...(error.retryAfterSeconds
              ? { retry_after_seconds: error.retryAfterSeconds }
              : {}),
          },
        },
        { status },
      );
    }
    if (error instanceof TrustedClientSourceError) {
      console.error("trusted_client_source_unavailable", { route: "email_login_start" });
      return noStoreJson({ error: { code: "service_unavailable" } }, { status: 503 });
    }
    console.error("email_login_start_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
