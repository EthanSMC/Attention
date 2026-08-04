import {
  createAuthorizationCode,
  OAuthError,
  validateAuthorizationRequest,
} from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { mutationRequestError } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import { getRequestSession } from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(code: string, status: number): NextResponse {
  return new Response(code, { headers: { "Cache-Control": "no-store" }, status }) as NextResponse;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return errorResponse(guardError, 400);
  const session = await getRequestSession(request);
  if (!session.principal) return errorResponse("authentication_required", 401);
  try {
    const form = await request.formData();
    const authorization = await validateAuthorizationRequest(getWebDatabase(), {
      audience: String(form.get("audience") ?? ""),
      clientId: String(form.get("client_id") ?? ""),
      codeChallenge: String(form.get("code_challenge") ?? ""),
      codeChallengeMethod: String(form.get("code_challenge_method") ?? ""),
      redirectUri: String(form.get("redirect_uri") ?? ""),
      responseType: String(form.get("response_type") ?? ""),
      scope: String(form.get("scope") ?? ""),
      state: typeof form.get("state") === "string" ? String(form.get("state")) : null,
    });
    const code = await createAuthorizationCode(
      getWebDatabase(),
      session.principal.accountId,
      authorization,
    );
    const redirectTo = new URL(authorization.redirectUri);
    redirectTo.searchParams.set("code", code);
    if (authorization.state) redirectTo.searchParams.set("state", authorization.state);
    return Response.redirect(redirectTo, 303) as NextResponse;
  } catch (error) {
    return errorResponse(error instanceof OAuthError ? error.code : "server_error", 400);
  }
}
