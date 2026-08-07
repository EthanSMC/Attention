import type { NextRequest } from "next/server";

import {
  handleGetInstallation,
  handleRevokeInstallation,
} from "../../../../../server/channel-runtime-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ installationId: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return handleGetInstallation(request, await context.params);
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return handleRevokeInstallation(request, await context.params);
}
