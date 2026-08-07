import type { NextRequest } from "next/server";

import {
  handleListInstallations,
  handleRegisterInstallation,
} from "../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return handleListInstallations(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleRegisterInstallation(request);
}
