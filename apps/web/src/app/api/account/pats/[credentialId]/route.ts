import { revokeApiCredential } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../server/db";
import { getRequestSession } from "../../../../../server/session";

const paramsSchema = z.object({ credentialId: z.string().uuid() });

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ credentialId: string }> },
): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return noStoreJson({ error: { code: guardError } }, { status: 400 });
  const session = await getRequestSession(request);
  if (!session.principal) return noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
  const revoked = await revokeApiCredential(
    getWebDatabase(),
    session.principal.accountId,
    params.data.credentialId,
  );
  return noStoreJson({ revoked });
}
