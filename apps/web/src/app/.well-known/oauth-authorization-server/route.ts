import { oauthScopes } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";
import { publicWebOrigin } from "../../../server/oauth-resources";

export const dynamic = "force-dynamic";

export function handleOAuthAuthorizationServerMetadataRequest(
  request: Request,
): NextResponse {
  const origin = publicWebOrigin(request);
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleOAuthAuthorizationServerMetadataRequest(request);
}
