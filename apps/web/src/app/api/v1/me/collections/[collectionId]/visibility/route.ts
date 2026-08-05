import {
  CollectionRepositoryError,
  setCollectionVisibility,
} from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../../../server/request-body";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VISIBILITY_BODY_BYTES = 8_192;

const bodySchema = z.object({ visibility: z.enum(["public", "private"]) }).strict();
const paramsSchema = z.object({ collectionId: z.string().uuid() });

interface RouteContext {
  params: Promise<{ collectionId: string }>;
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestError = mutationRequestError(request);
  if (requestError) {
    return noStoreJson({ error: { code: requestError } }, { status: 400 });
  }
  const requestSession = await getRequestSession(request);
  const principal = requestSession.principal;
  if (!principal) {
    const response = noStoreJson(
      { error: { code: "authentication_required" } },
      { status: 401 },
    );
    clearInvalidSessionCookie(response, requestSession);
    return response;
  }

  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_VISIBILITY_BODY_BYTES),
    );
    const { collectionId } = paramsSchema.parse(await context.params);
    if (body.visibility === "public" && !principal.isFilter) {
      return noStoreJson({ error: { code: "filter_required" } }, { status: 403 });
    }
    const collection = await setCollectionVisibility(getWebDatabase(), {
      accountId: principal.accountId,
      collectionId,
      visibility: body.visibility,
    });
    return noStoreJson({ visibility: collection.visibility });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    if (error instanceof CollectionRepositoryError) {
      const status = error.code === "collection_not_found" ? 404 : 403;
      return noStoreJson({ error: { code: error.code } }, { status });
    }
    console.error("collection_visibility_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
