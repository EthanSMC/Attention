import { PasswordAuthError, setPassword } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ password: z.string().max(128) }).strict();

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
    const body = bodySchema.parse(await request.json());
    await setPassword(getWebDatabase(), {
      accountId: requestSession.principal.accountId,
      authenticatedAt: requestSession.principal.authenticatedAt,
      password: body.password,
    });
    return noStoreJson({ configured: true });
  } catch (error) {
    if (error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    if (error instanceof PasswordAuthError) {
      return noStoreJson(
        { error: { code: error.code } },
        { status: error.code === "recent_authentication_required" ? 403 : 400 },
      );
    }
    console.error("password_configuration_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
