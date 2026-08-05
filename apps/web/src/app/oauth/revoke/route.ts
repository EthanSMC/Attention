import { revokeOAuthToken } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";
import {
  InvalidRequestBodyError,
  readUrlEncodedRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_OAUTH_FORM_BODY_BYTES = 16_384;

export async function handleOAuthRevokeRequest(
  request: Request,
  db: AttentionDatabase = getWebDatabase(),
): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return noStoreJson({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const form = await readUrlEncodedRequestWithinLimit(
      request,
      MAX_OAUTH_FORM_BODY_BYTES,
    );
    await revokeOAuthToken(db, form.get("token") ?? "");
    return noStoreJson({});
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: "invalid_request" }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError) {
      return noStoreJson({ error: "invalid_request" }, { status: 400 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleOAuthRevokeRequest(request);
}
