import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : request.nextUrl.origin;
  return noStoreJson({
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource: process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`,
    scopes_supported: [
      "profile:read",
      "collection:read",
      "collection:write",
      "public:read",
      "public:full",
      "ai:search",
    ],
  });
}
