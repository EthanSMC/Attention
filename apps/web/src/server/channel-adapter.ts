import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export function authorizeChannelAdapter(request: Request): boolean {
  const expected = process.env.ATTENTION_CHANNEL_ADAPTER_SECRET?.trim();
  const header = request.headers.get("authorization");
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function channelIdempotencyKey(
  provider: string,
  appId: string,
  channelMessageId: string,
): string {
  return createHash("sha256")
    .update("attention:channel-message:v1\0")
    .update(provider).update("\0").update(appId).update("\0").update(channelMessageId)
    .digest("base64url");
}
