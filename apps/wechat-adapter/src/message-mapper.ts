import { createHmac } from "node:crypto";

import type { NormalizedWechatMessage } from "./types.js";

export class WechatMessageError extends Error {
  constructor(readonly code: "invalid_message" | "unsupported_message") {
    super(code);
    this.name = "WechatMessageError";
  }
}

function requiredField(fields: Record<string, string>, name: string, maxLength: number): string {
  const value = fields[name]?.trim();
  if (!value || value.length > maxLength) throw new WechatMessageError("invalid_message");
  return value;
}

function messageId(
  fields: Record<string, string>,
  appId: string,
  rawInput: string,
  hmacSecret: string,
): string {
  const createTime = requiredField(fields, "CreateTime", 12);
  if (!/^\d{1,12}$/u.test(createTime)) throw new WechatMessageError("invalid_message");
  const officialId = fields.MsgId?.trim();
  if (officialId) {
    if (!/^\d{1,64}$/u.test(officialId)) throw new WechatMessageError("invalid_message");
    return `msg:${officialId}:${createTime}`;
  }
  return `fallback:${createHmac("sha256", hmacSecret)
    .update("attention:wechat-message:v1\0")
    .update(appId).update("\0")
    .update(requiredField(fields, "FromUserName", 128)).update("\0")
    .update(requiredField(fields, "MsgType", 32)).update("\0")
    .update(createTime).update("\0")
    .update(rawInput)
    .digest("base64url")}`;
}

function linkCardInput(fields: Record<string, string>): string {
  const url = requiredField(fields, "Url", 8_192);
  const title = fields.Title?.trim().slice(0, 1_024) ?? "";
  const description = fields.Description?.trim().slice(0, 4_096) ?? "";
  return [title, description, url].filter(Boolean).join("\n");
}

export function normalizeWechatMessage(input: {
  appId: string;
  fields: Record<string, string>;
  hmacSecret: string;
  originalId?: string | null;
}): NormalizedWechatMessage {
  const msgType = requiredField(input.fields, "MsgType", 32).toLowerCase();
  const toUser = requiredField(input.fields, "ToUserName", 128);
  if (input.originalId && toUser !== input.originalId) {
    throw new WechatMessageError("invalid_message");
  }
  const fromUser = requiredField(input.fields, "FromUserName", 128);
  let rawInput: string;
  let action: "agent" | "collect";
  if (msgType === "text") {
    rawInput = requiredField(input.fields, "Content", 32_768);
    action = /https?:\/\//iu.test(rawInput) ? "collect" : "agent";
  } else if (msgType === "link") {
    rawInput = linkCardInput(input.fields);
    action = "collect";
  } else {
    throw new WechatMessageError("unsupported_message");
  }
  const createTimeValue = requiredField(input.fields, "CreateTime", 12);
  const createTime = Number(createTimeValue);
  if (!Number.isSafeInteger(createTime) || createTime < 0) {
    throw new WechatMessageError("invalid_message");
  }
  return {
    action,
    appId: input.appId,
    channelMessageId: messageId(input.fields, input.appId, rawInput, input.hmacSecret),
    createTime,
    fromUser,
    rawInput,
    toUser,
  };
}
