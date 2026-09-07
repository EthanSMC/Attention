import type { NextRequest, NextResponse } from "next/server";
import { handleOAuthRegistrationRequest } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleOAuthRegistrationRequest(request);
}
