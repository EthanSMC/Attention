import { OAuthError, validateAuthorizationRequest } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { getWebDatabase } from "../../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = request.nextUrl.searchParams;
    const authorization = await validateAuthorizationRequest(getWebDatabase(), {
      audience: query.get("audience") ?? "",
      clientId: query.get("client_id") ?? "",
      codeChallenge: query.get("code_challenge") ?? "",
      codeChallengeMethod: query.get("code_challenge_method") ?? "",
      redirectUri: query.get("redirect_uri") ?? "",
      responseType: query.get("response_type") ?? "",
      scope: query.get("scope") ?? "",
      state: query.get("state"),
    });
    const redirectTo = new URL(authorization.redirectUri);
    redirectTo.searchParams.set("error", "access_denied");
    if (authorization.state) redirectTo.searchParams.set("state", authorization.state);
    return Response.redirect(redirectTo, 303) as NextResponse;
  } catch (error) {
    const code = error instanceof OAuthError ? error.code : "invalid_request";
    return new Response(code, {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    }) as NextResponse;
  }
}
