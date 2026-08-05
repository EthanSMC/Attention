import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import {
  AttentionIdError,
  updateAttentionId,
} from "../../../../server/account";
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

const MAX_ATTENTION_ID_BODY_BYTES = 1_024;
const bodySchema = z.object({ attention_id: z.string().max(64) }).strict();

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestError = mutationRequestError(request);
  if (requestError) {
    return noStoreJson({ error: { code: requestError } }, { status: 400 });
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
      await readJsonRequestWithinLimit(request, MAX_ATTENTION_ID_BODY_BYTES),
    );
    const result = await updateAttentionId(
      getWebDatabase(),
      requestSession.principal.accountId,
      body.attention_id,
    );
    return noStoreJson({
      attention_id: result.attentionId,
      next_change_at: result.nextChangeAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson(
        { error: { code: "invalid_attention_id" } },
        { status: 400 },
      );
    }
    if (error instanceof AttentionIdError) {
      const status =
        error.code === "attention_id_taken" ||
        error.code === "attention_id_cooldown"
          ? 409
          : error.code === "account_not_found"
            ? 404
            : 400;
      return noStoreJson(
        {
          error: { code: error.code },
          ...(error.nextChangeAt
            ? { next_change_at: error.nextChangeAt.toISOString() }
            : {}),
        },
        { status },
      );
    }
    console.error("attention_id_update_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
