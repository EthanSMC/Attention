import { describe, expect, it } from "vitest";

import { normalizeWechatMessage, WechatMessageError } from "./message-mapper.js";

const base = {
  CreateTime: "1700000000",
  FromUserName: "openid-sensitive",
  MsgId: "123456789",
  ToUserName: "gh_attention",
};

describe("WeChat message normalization", () => {
  it("maps questions and URL-bearing text to the shared channel envelope", () => {
    const question = normalizeWechatMessage({
      appId: "wx1234567890abcdef",
      fields: { ...base, Content: "我收藏过哪些 AI 文章？", MsgType: "text" },
      hmacSecret: "x".repeat(32),
    });
    expect(question).toMatchObject({
      action: "agent",
      channelMessageId: "msg:123456789:1700000000",
      rawInput: "我收藏过哪些 AI 文章？",
    });
    const linkText = normalizeWechatMessage({
      appId: "wx1234567890abcdef",
      fields: { ...base, Content: "收藏 https://example.com/post", MsgType: "text" },
      hmacSecret: "x".repeat(32),
    });
    expect(linkText.action).toBe("collect");
  });

  it("maps official-account link cards without fetching the URL", () => {
    const result = normalizeWechatMessage({
      appId: "wx1234567890abcdef",
      fields: {
        ...base,
        Description: "summary",
        MsgType: "link",
        Title: "article",
        Url: "https://example.com/post",
      },
      hmacSecret: "x".repeat(32),
    });
    expect(result).toMatchObject({
      action: "collect",
      rawInput: "article\nsummary\nhttps://example.com/post",
    });
  });

  it("uses MsgId/CreateTime for retry identity and hashes the fallback identity", () => {
    const first = normalizeWechatMessage({
      appId: "wx1234567890abcdef",
      fields: { ...base, Content: "hello", MsgType: "text" },
      hmacSecret: "x".repeat(32),
    });
    const retry = normalizeWechatMessage({
      appId: "wx1234567890abcdef",
      fields: { ...base, Content: "hello", MsgType: "text" },
      hmacSecret: "x".repeat(32),
    });
    expect(retry.channelMessageId).toBe(first.channelMessageId);
    const fallback = normalizeWechatMessage({
      appId: "wx1234567890abcdef",
      fields: { ...base, Content: "hello", MsgId: "", MsgType: "text" },
      hmacSecret: "x".repeat(32),
    });
    expect(fallback.channelMessageId).toMatch(/^fallback:[A-Za-z0-9_-]{43}$/u);
    expect(fallback.channelMessageId).not.toContain("openid-sensitive");
  });

  it("leaves unsupported event messages unhandled", () => {
    expect(() => normalizeWechatMessage({
      appId: "wx1234567890abcdef",
      fields: { ...base, Event: "subscribe", MsgType: "event" },
      hmacSecret: "x".repeat(32),
    })).toThrowError(new WechatMessageError("unsupported_message"));
  });
});
