import { CollectionRepositoryError } from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import {
  collectFromWeb,
  CollectionServiceError,
} from "../../../../server/collection-service";
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

const MAX_COLLECTION_ATTEMPT_BODY_BYTES = 65_536;

function serviceError(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
  }
  if (error instanceof InvalidRequestBodyError) {
    return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
  }
  if (error instanceof CollectionServiceError) {
    return noStoreJson(
      { error: { code: error.code } },
      { status: error.httpStatus },
    );
  }
  if (error instanceof CollectionRepositoryError) {
    const status =
      error.code === "collection_not_found" ? 404 : error.code === "collection_deleted" ? 409 : 403;
    return noStoreJson({ error: { code: error.code } }, { status });
  }
  if (error instanceof ZodError) {
    return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
  }
  console.error("collection_attempt_failed", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    const body = await readJsonRequestWithinLimit(
      request,
      MAX_COLLECTION_ATTEMPT_BODY_BYTES,
    );
    const result = await collectFromWeb(
      getWebDatabase(),
      requestSession.principal,
      body,
    );
    return noStoreJson(result);
  } catch (error) {
    return serviceError(error);
  }
}
