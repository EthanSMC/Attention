import { createConsumerInvite, GrowthError } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../server/request-body";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_GROWTH_ACTION_BODY_BYTES = 8_192;

const bodySchema = z.object({ replace_active: z.boolean().optional() }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return noStoreJson({ error: { code: guardError } }, { status: 400 });
  const session = await getRequestSession(request);
  if (!session.principal) {
    const response = noStoreJson(
      { error: { code: "authentication_required" } },
      { status: 401 },
    );
    clearInvalidSessionCookie(response, session);
    return response;
  }
  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_GROWTH_ACTION_BODY_BYTES),
    );
    const invitation = await createConsumerInvite(getWebDatabase(), {
      accountId: session.principal.accountId,
      replaceActive: body.replace_active ?? false,
    });
    return noStoreJson({
      expires_at: invitation.expiresAt.toISOString(),
      invitation_id: invitation.invitationId,
      join_path: `/join/${invitation.token}`,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    if (error instanceof GrowthError) {
      const status = error.code === "account_not_active" ? 403 : 409;
      return noStoreJson({ error: { code: error.code } }, { status });
    }
    console.error("consumer_invite_create_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
