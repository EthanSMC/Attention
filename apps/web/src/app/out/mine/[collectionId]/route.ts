import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getWebDatabase } from "../../../../server/db";
import { findOwnedOutboundUrl, parseSafeOutboundUrl } from "../../../../server/outbound";
import {
  outboundRedirect,
  outboundUnavailable,
} from "../../../../server/outbound-response";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ collectionId: z.string().uuid() });

interface RouteContext {
  params: Promise<{ collectionId: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestSession = await getRequestSession(request);
  const principal = requestSession.principal;
  if (!principal?.isMember) {
    const response = outboundUnavailable("请先登录后再查看这条收藏。", 401);
    clearInvalidSessionCookie(response, requestSession);
    return response;
  }

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return outboundUnavailable();

  try {
    const outboundUrl = parseSafeOutboundUrl(
      await findOwnedOutboundUrl(
        getWebDatabase(),
        principal.accountId,
        parsed.data.collectionId,
      ),
    );
    return outboundUrl ? outboundRedirect(outboundUrl) : outboundUnavailable();
  } catch (error) {
    console.error("owned_outbound_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return outboundUnavailable("原文跳转服务暂时不可用。", 503);
  }
}
