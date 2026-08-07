import type { NextRequest } from "next/server";

import {
  handleCreateChannelBinding,
  handleListChannelBindings,
} from "../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return handleListChannelBindings(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleCreateChannelBinding(request);
}
