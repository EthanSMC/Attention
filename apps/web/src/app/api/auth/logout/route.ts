import { NextResponse } from "next/server";

import { mutationRequestError } from "../../../../server/api-guard";
import {
  clearSessionCookie,
  revokeRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (mutationRequestError(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  await revokeRequestSession(request);
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const baseUrl = configuredOrigin ? new URL(configuredOrigin) : new URL(request.url);
  const response = NextResponse.redirect(new URL("/ai", baseUrl), 303);
  response.headers.set("Cache-Control", "no-store");
  clearSessionCookie(response);
  return response;
}
