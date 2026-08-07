import { oauthScopesByAudience } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../../../server/api-guard";
import { oauthResourceMap, publicWebOrigin } from "../../../../../server/oauth-resources";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return noStoreJson({
    authorization_servers: [publicWebOrigin(request)],
    bearer_methods_supported: ["header"],
    resource: oauthResourceMap(request)["attention-sync"],
    scopes_supported: oauthScopesByAudience["attention-sync"],
  });
}
