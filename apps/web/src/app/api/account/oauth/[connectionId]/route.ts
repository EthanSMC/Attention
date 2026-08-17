import {
  OAuthConnectionNameConflictError,
  OAuthConnectionNotFoundError,
  renameOAuthConnection,
  revokeOAuthConnection,
} from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../server/request-body";
import { getRequestSession } from "../../../../../server/session";

const paramsSchema = z.object({ connectionId: z.string().uuid() });
const renameBodySchema = z.object({
  label: z.string().min(1).max(160),
}).strict();

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) {
    return noStoreJson({ error: { code: guardError } }, { status: 400 });
  }
  const session = await getRequestSession(request);
  if (!session.principal) {
    return noStoreJson(
      { error: { code: "authentication_required" } },
      { status: 401 },
    );
  }
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return noStoreJson(
      { error: { code: "invalid_request" } },
      { status: 400 },
    );
  }

  try {
    const body = renameBodySchema.parse(
      await readJsonRequestWithinLimit(request, 2_048),
    );
    const result = await renameOAuthConnection(getWebDatabase(), {
      accountId: session.principal.accountId,
      connectionId: params.data.connectionId,
      label: body.label,
    });
    return noStoreJson(result);
  } catch (error) {
    if (error instanceof OAuthConnectionNameConflictError) {
      return noStoreJson(
        { error: { code: "oauth_connection_name_conflict" } },
        { status: 409 },
      );
    }
    if (error instanceof OAuthConnectionNotFoundError) {
      return noStoreJson(
        { error: { code: "oauth_connection_not_found" } },
        { status: 404 },
      );
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof RequestBodyTooLargeError ||
      error instanceof ZodError ||
      (error instanceof Error && error.message === "invalid_connection_label")
    ) {
      return noStoreJson(
        { error: { code: "invalid_request" } },
        { status: 400 },
      );
    }
    return noStoreJson(
      { error: { code: "server_error" } },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return noStoreJson({ error: { code: guardError } }, { status: 400 });
  const session = await getRequestSession(request);
  if (!session.principal) return noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
  await revokeOAuthConnection(
    getWebDatabase(),
    session.principal.accountId,
    params.data.connectionId,
  );
  return noStoreJson({ revoked: true });
}
