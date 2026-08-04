import { revokeOAuthToken } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return noStoreJson({ error: "invalid_request" }, { status: 413 });
  }
  const form = await request.formData();
  await revokeOAuthToken(getWebDatabase(), String(form.get("token") ?? ""));
  return noStoreJson({});
}
