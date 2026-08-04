import {
  createChannelBindIntent,
  resolveChannelIdentity,
} from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { retrieveForAgent } from "../../../../server/agent-retrieval";
import {
  authorizeChannelAdapter,
  channelIdempotencyKey,
} from "../../../../server/channel-adapter";
import { collectFromWeb } from "../../../../server/collection-service";
import { noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CHANNEL_MESSAGE_BODY_BYTES = 65_536;

const bodySchema = z.object({
  action: z.enum(["collect", "agent"]),
  app_id: z.string().min(1).max(128),
  channel_message_id: z.string().min(1).max(255),
  provider: z.enum(["wechat", "wecom", "douyin", "xiaohongshu"]),
  raw_input: z.string().min(1).max(32_768),
  subject_id: z.string().min(1).max(512),
}).strict();

function publicOrigin(request: NextRequest): string {
  return process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : request.nextUrl.origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorizeChannelAdapter(request)) {
    return noStoreJson({ error: { code: "adapter_authentication_required" } }, { status: 401 });
  }
  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_CHANNEL_MESSAGE_BODY_BYTES),
    );
    const db = getWebDatabase();
    const identity = await resolveChannelIdentity(db, {
      appId: body.app_id,
      provider: body.provider,
      subjectId: body.subject_id,
    });
    if (!identity) {
      const intent = await createChannelBindIntent(db, {
        action: body.action,
        appId: body.app_id,
        channelMessageId: body.channel_message_id,
        provider: body.provider,
        rawInput: body.raw_input,
        subjectId: body.subject_id,
      });
      return noStoreJson({
        bind_url: `${publicOrigin(request)}/channel/bind?token=${encodeURIComponent(intent.bindToken)}`,
        expires_at: intent.expiresAt.toISOString(),
        pending_request_id: intent.pendingRequestId,
        status: "binding_required",
      }, { status: 202 });
    }
    if (!identity.isMember) {
      const intent = await createChannelBindIntent(db, {
        action: body.action,
        appId: body.app_id,
        channelMessageId: body.channel_message_id,
        provider: body.provider,
        rawInput: body.raw_input,
        subjectId: body.subject_id,
      });
      const bindPath = `/channel/bind?token=${encodeURIComponent(intent.bindToken)}`;
      const origin = publicOrigin(request);
      return noStoreJson({
        bind_url: `${origin}${bindPath}`,
        expires_at: intent.expiresAt.toISOString(),
        membership_url: `${origin}/membership?return_to=${encodeURIComponent(bindPath)}`,
        pending_request_id: intent.pendingRequestId,
        status: "membership_required",
      }, { status: 403 });
    }
    if (body.action === "agent") {
      return noStoreJson({
        result: await retrieveForAgent(db, identity.accountId, body.raw_input),
        status: "completed",
      });
    }
    return noStoreJson({
      result: await collectFromWeb(db, identity, {
        idempotency_key: channelIdempotencyKey(body.provider, body.app_id, body.channel_message_id),
        raw_input: body.raw_input,
        visibility: identity.isFilter ? "public" : "private",
      }),
      status: "completed",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    console.error("channel_message_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return noStoreJson({ error: { code: "processing_failed" } }, { status: 500 });
  }
}
