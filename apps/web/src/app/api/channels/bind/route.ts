import type { NextResponse } from "next/server";

import { disabledChannelEntryResponse } from "../../../../server/disabled-channel-entry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  return disabledChannelEntryResponse();
}
