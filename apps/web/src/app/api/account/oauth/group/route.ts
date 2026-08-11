import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import { revokeMcpOAuthConnectionGroup } from "../../../../../server/account";
import { getWebDatabase } from "../../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../server/request-body";
import { getRequestSession } from "../../../../../server/session";

const bodySchema = z.object({
  client_name: z.string().min(1).max(100),
}).strict();

export async function DELETE(request: NextRequest): Promise<NextResponse> {
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
  try {
    const body = bodySchema.parse(await readJsonRequestWithinLimit(request, 4_096));
    const revokedCount = await revokeMcpOAuthConnectionGroup(
      getWebDatabase(),
      {
        accountId: session.principal.accountId,
        clientName: body.client_name,
      },
    );
    return noStoreJson({ revoked_count: revokedCount });
  } catch (error) {
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof RequestBodyTooLargeError ||
      error instanceof RangeError ||
      error instanceof ZodError
    ) {
      return noStoreJson(
        { error: { code: "invalid_request" } },
        { status: 400 },
      );
    }
    return noStoreJson({ error: { code: "server_error" } }, { status: 500 });
  }
}
