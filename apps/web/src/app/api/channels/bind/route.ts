import {
  ChannelBindingError,
  completeChannelPendingRequest,
  confirmChannelBindIntent,
  failChannelPendingRequest,
} from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { mutationRequestError } from "../../../../server/api-guard";
import { retrieveForAgent } from "../../../../server/agent-retrieval";
import { collectFromWeb } from "../../../../server/collection-service";
import { getWebDatabase } from "../../../../server/db";
import {
  readUrlEncodedRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../server/request-body";
import { getRequestSession } from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CHANNEL_BIND_BODY_BYTES = 8_192;

function textResponse(value: string, status: number): NextResponse {
  return new Response(value, { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }, status }) as NextResponse;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return textResponse(guardError, 400);
  const session = await getRequestSession(request);
  if (!session.principal) return textResponse("authentication_required", 401);
  let resumedPendingRequestId: string | null = null;
  try {
    const form = await readUrlEncodedRequestWithinLimit(request, MAX_CHANNEL_BIND_BODY_BYTES);
    const token = form.get("token") ?? "";
    const resumed = await confirmChannelBindIntent(getWebDatabase(), {
      accountId: session.principal.accountId,
      token,
    });
    resumedPendingRequestId = resumed.pendingRequestId;
    let result: unknown;
    if (resumed.action === "agent") {
      result = await retrieveForAgent(getWebDatabase(), session.principal.accountId, resumed.rawInput);
    } else {
      result = await collectFromWeb(getWebDatabase(), session.principal, {
        idempotency_key: `bind-${resumed.pendingRequestId}`,
        raw_input: resumed.rawInput,
        visibility: session.principal.isFilter ? "public" : "private",
      });
    }
    await completeChannelPendingRequest(getWebDatabase(), resumed.pendingRequestId, result);
    return Response.redirect(new URL("/account/connections?channel=bound", request.url), 303) as NextResponse;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return textResponse("request_too_large", 413);
    }
    if (!(error instanceof ChannelBindingError) && resumedPendingRequestId) {
      await failChannelPendingRequest(getWebDatabase(), resumedPendingRequestId, "processing_failed");
    }
    const code = error instanceof ChannelBindingError ? error.code : "binding_failed";
    return textResponse(code, code === "membership_required" ? 403 : 409);
  }
}
