import type { NextRequest } from "next/server";

import { handleChannelBindingActivity } from "../../../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ bindingId: string }>;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return handleChannelBindingActivity(request, await context.params);
}
