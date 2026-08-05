import { createApiCredential } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
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

const MAX_PAT_BODY_BYTES = 8_192;

const bodySchema = z.object({
  expires_in_days: z.number().int().min(1).max(365).default(90),
  name: z.string().min(1).max(100),
}).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return noStoreJson({ error: { code: guardError } }, { status: 400 });
  const session = await getRequestSession(request);
  if (!session.principal) {
    const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
    clearInvalidSessionCookie(response, session);
    return response;
  }
  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_PAT_BODY_BYTES),
    );
    const credential = await createApiCredential(getWebDatabase(), {
      accountId: session.principal.accountId,
      expiresAt: new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1_000),
      name: body.name,
    });
    return noStoreJson({
      credential_id: credential.credentialId,
      expires_at: credential.expiresAt?.toISOString() ?? null,
      key: credential.key,
      key_prefix: credential.keyPrefix,
      name: credential.name,
      warning: "此密钥只显示一次，请立即保存。",
    }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof ZodError ||
      error instanceof RangeError
    ) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    console.error("pat_creation_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
