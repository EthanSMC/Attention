import { readChannelPendingResult } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { noStoreJson } from "../../../../../server/api-guard";
import { authorizeChannelAdapter } from "../../../../../server/channel-adapter";
import { getWebDatabase } from "../../../../../server/db";

const paramsSchema = z.object({ pendingRequestId: z.string().uuid() });

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ pendingRequestId: string }> },
): Promise<NextResponse> {
  if (!authorizeChannelAdapter(request)) {
    return noStoreJson({ error: { code: "adapter_authentication_required" } }, { status: 401 });
  }
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
  const result = await readChannelPendingResult(getWebDatabase(), params.data.pendingRequestId);
  if (!result) return noStoreJson({ error: { code: "not_found" } }, { status: 404 });
  return noStoreJson(result, { status: result.status === "pending" ? 202 : 200 });
}
