import type { NextRequest } from "next/server";

import { handleVerifyChannelBinding } from "../../../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ bindingId: string }>;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return handleVerifyChannelBinding(request, await context.params);
}
