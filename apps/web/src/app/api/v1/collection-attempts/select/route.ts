import { CollectionRepositoryError } from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import {
  CollectionServiceError,
  selectCandidateFromWeb,
} from "../../../../../server/collection-service";
import { getWebDatabase } from "../../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function serviceError(error: unknown): NextResponse {
  if (error instanceof CollectionServiceError) {
    return noStoreJson(
      { error: { code: error.code } },
      { status: error.httpStatus },
    );
  }
  if (error instanceof CollectionRepositoryError) {
    return noStoreJson({ error: { code: error.code } }, { status: 403 });
  }
  if (error instanceof ZodError) {
    return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
  }
  console.error("candidate_selection_failed", {
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
    const body: unknown = await request.json();
    const result = await selectCandidateFromWeb(
      getWebDatabase(),
      requestSession.principal,
      body,
    );
    return noStoreJson(result);
  } catch (error) {
    return serviceError(error);
  }
}
