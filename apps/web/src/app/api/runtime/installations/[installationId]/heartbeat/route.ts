import type { NextRequest } from "next/server";

import { handleInstallationHeartbeat } from "../../../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ installationId: string }>;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return handleInstallationHeartbeat(request, await context.params);
}
