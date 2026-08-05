import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getWebDatabase } from "../../../../server/db";
import {
  findPublicOutboundUrl,
  isPublicContentInsidePreview,
  parseSafeOutboundUrl,
} from "../../../../server/outbound";
import {
  outboundRedirect,
  outboundUnavailable,
} from "../../../../server/outbound-response";
import { hasCompletePublicAccess } from "../../../../server/public-access";
import { getRequestSession } from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ publicId: z.string().uuid() });

interface RouteContext {
  params: Promise<{ publicId: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return outboundUnavailable();

  try {
    const requestSession = await getRequestSession(request);
    const mayOpen =
      hasCompletePublicAccess(requestSession.principal) ||
      (await isPublicContentInsidePreview(getWebDatabase(), parsed.data.publicId));
    if (!mayOpen) {
      return outboundUnavailable("这篇内容需要 Member 才能打开。", 403);
    }
    const outboundUrl = parseSafeOutboundUrl(
      await findPublicOutboundUrl(getWebDatabase(), parsed.data.publicId),
    );
    return outboundUrl ? outboundRedirect(outboundUrl) : outboundUnavailable();
  } catch (error) {
    console.error("public_outbound_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return outboundUnavailable("原文跳转服务暂时不可用。", 503);
  }
}
