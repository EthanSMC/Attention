import { describe, expect, it } from "vitest";

import {
  extractText,
  messageIdentifier,
  parseInboundMessage,
} from "./messages";

describe("extractText", () => {
  it("joins text items", () => {
    const result = extractText([
      { text_item: { text: "a" }, type: 1 },
      { text_item: { text: " b " }, type: 1 },
    ]);
    expect(result).toEqual({ nonTextOnly: false, text: "a\nb" });
  });

  it("counts voice transcripts as text", () => {
    const result = extractText([{ type: 3, voice_item: { text: "语音转写" } }]);
    expect(result).toEqual({ nonTextOnly: false, text: "语音转写" });
  });

  it("marks voice without transcript as non-text", () => {
    const result = extractText([{ type: 3, voice_item: {} }]);
    expect(result).toEqual({ nonTextOnly: true, text: "" });
  });

  it.each([2, 4, 5])("marks item type %i as non-text", (type) => {
    const result = extractText([{ type }]);
    expect(result).toEqual({ nonTextOnly: true, text: "" });
  });

  it("handles mixed text and image items", () => {
    const result = extractText([
      { text_item: { text: "链接" }, type: 1 },
      { type: 2 },
    ]);
    expect(result.text).toBe("链接");
    expect(result.nonTextOnly).toBe(false);
  });

  it("extracts title and nested text from a referenced WeChat share", () => {
    const result = extractText([
      {
        ref_msg: {
          message_item: {
            text_item: {
              text: "https://mp.weixin.qq.com/s/example",
            },
            type: 1,
          },
          title: "一篇值得收藏的公众号文章",
        },
        type: 1,
      },
    ]);
    expect(result).toEqual({
      nonTextOnly: false,
      text: "一篇值得收藏的公众号文章\nhttps://mp.weixin.qq.com/s/example",
    });
  });

  it("tolerates malformed item lists", () => {
    expect(extractText(undefined)).toEqual({ nonTextOnly: false, text: "" });
    expect(extractText([null, "x", { type: "nope" }])).toEqual({
      nonTextOnly: false,
      text: "",
    });
  });
});

describe("parseInboundMessage", () => {
  it("parses a well-formed message", () => {
    const message = parseInboundMessage({
      context_token: "ctx",
      from_user_id: "user-1",
      item_list: [{ text_item: { text: "hi" }, type: 1 }],
    });
    expect(message).not.toBeNull();
    expect(message?.fromUserId).toBe("user-1");
    expect(message?.contextToken).toBe("ctx");
  });

  it("rejects entries without a sender", () => {
    expect(parseInboundMessage({ context_token: "ctx" })).toBeNull();
    expect(parseInboundMessage(null)).toBeNull();
    expect(parseInboundMessage("string")).toBeNull();
  });
});

describe("messageIdentifier", () => {
  const baseMessage = {
    contextToken: "ctx",
    fromUserId: "user-1",
    itemList: [{ text_item: { text: "hi" }, type: 1 }],
    raw: { from_user_id: "user-1" },
  };

  it("prefers an explicit client id when present", () => {
    const message = {
      ...baseMessage,
      raw: { ...baseMessage.raw, client_id: "abc-123" },
    };
    expect(messageIdentifier(message)).toBe("abc-123");
  });

  it("falls back to a stable content fingerprint", () => {
    const first = messageIdentifier(baseMessage);
    const second = messageIdentifier({ ...baseMessage });
    expect(first).toMatch(/^fp-[0-9a-f]{32}$/u);
    expect(first).toBe(second);
  });

  it("changes the fingerprint when content changes", () => {
    const other = messageIdentifier({
      ...baseMessage,
      itemList: [{ text_item: { text: "different" }, type: 1 }],
    });
    expect(other).not.toBe(messageIdentifier(baseMessage));
  });
});
