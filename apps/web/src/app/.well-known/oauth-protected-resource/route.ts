import { oauthScopesByAudience } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";
import { oauthResourceMap, publicWebOrigin } from "../../../server/oauth-resources";

export const dynamic = "force-dynamic";

export function handleMcpProtectedResourceMetadataRequest(
  request: Request,
): NextResponse {
  const origin = publicWebOrigin(request);
  return noStoreJson({
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource: oauthResourceMap(request)["attention-mcp"],
    scopes_supported: oauthScopesByAudience["attention-mcp"],
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleMcpProtectedResourceMetadataRequest(request);
}
