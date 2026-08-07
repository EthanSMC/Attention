import type { NextRequest } from "next/server";

import { handleGetChannelBinding } from "../../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ bindingId: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return handleGetChannelBinding(request, await context.params);
}
