import {
  findModerationCourtOutboundUrl,
  ModerationRepositoryError,
} from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getWebDatabase } from "../../../../server/db";
import {
  outboundRedirect,
  outboundUnavailable,
} from "../../../../server/outbound-response";
import { parseSafeOutboundUrl } from "../../../../server/outbound";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ caseId: z.string().uuid() });

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ caseId: string }> },
): Promise<NextResponse> {
  const requestSession = await getRequestSession(request);
  if (!requestSession.principal) {
    const response = outboundUnavailable("请先登录 Filter 账号。", 401);
    clearInvalidSessionCookie(response, requestSession);
    return response;
  }
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return outboundUnavailable();
  try {
    const url = parseSafeOutboundUrl(
      await findModerationCourtOutboundUrl(getWebDatabase(), {
        accountId: requestSession.principal.accountId,
        caseId: parsed.data.caseId,
      }),
    );
    return url ? outboundRedirect(url) : outboundUnavailable();
  } catch (error) {
    if (
      error instanceof ModerationRepositoryError &&
      error.code === "filter_required"
    ) {
      return outboundUnavailable("只有当前有效 Filter 可以查看小法庭原文。", 403);
    }
    console.error("moderation_court_outbound_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return outboundUnavailable("原文跳转服务暂时不可用。", 503);
  }
}
