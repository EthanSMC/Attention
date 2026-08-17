import type { NextRequest } from "next/server";

import { handleListSummaryNotifications } from "../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return handleListSummaryNotifications(request);
}
