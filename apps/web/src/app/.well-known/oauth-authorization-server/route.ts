import { oauthScopes } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : request.nextUrl.origin;
  return noStoreJson({
    authorization_endpoint: `${origin}/oauth/authorize`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: origin,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: oauthScopes,
    token_endpoint: `${origin}/oauth/token`,
    token_endpoint_auth_methods_supported: ["none"],
  });
}
