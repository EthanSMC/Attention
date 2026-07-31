import {
  extractLinkCandidates,
  extractUrlsFromText
} from "@attention/collector";
import type { InputEnvelope } from "@attention/contracts";
import { collectorFixtures } from "@attention/testkit";
import { describe, expect, it } from "vitest";

describe("extractUrlsFromText", () => {
  it("removes Chinese wrapper punctuation without changing URL internals", () => {
    expect(
      extractLinkCandidates(collectorFixtures.chinesePunctuationEnvelope).map(
        ({ url }) => url
      )
    ).toEqual([
      "https://example.com/alpha?x=1",
      "https://example.org/beta"
    ]);
  });

  it("removes zero-width characters before parsing", () => {
    expect(
      extractLinkCandidates(collectorFixtures.zeroWidthEnvelope).map(
        ({ url }) => url
      )
    ).toEqual(["https://example.com/path?from=share"]);
  });

  it("extracts platform shortlinks from complete share text", () => {
    expect(
      extractLinkCandidates(collectorFixtures.douyinShareEnvelope)[0]?.url
    ).toBe("https://v.douyin.com/iRFixture/");
    expect(
      extractLinkCandidates(collectorFixtures.xiaohongshuShareEnvelope)[0]?.url
    ).toBe("http://xhslink.com/aBcDeFg");
    expect(
      extractLinkCandidates(collectorFixtures.wechatShareEnvelope)[0]?.url
    ).toContain("https://mp.weixin.qq.com/s?");
  });

  it("deduplicates exact candidates while preserving first-seen order", () => {
    expect(
      extractUrlsFromText(
        "https://example.com/a https://example.org/b https://example.com/a"
      )
    ).toEqual(["https://example.com/a", "https://example.org/b"]);
  });

  it("keeps balanced ASCII parentheses that are part of a URL", () => {
    expect(
      extractUrlsFromText(
        "See (https://example.com/wiki/Function_(mathematics))."
      )
    ).toEqual(["https://example.com/wiki/Function_(mathematics)"]);
  });

  it("ignores non-HTTP schemes and malformed URLs", () => {
    expect(
      extractUrlsFromText(
        "file:///etc/passwd ftp://example.com https://[not-an-ip"
      )
    ).toEqual([]);
  });

  it("filters exact known app downloads and platform marketing pages", () => {
    expect(
      extractUrlsFromText(
        "https://apps.apple.com/cn/app/example https://www.douyin.com/downloadpage https://example.com/article"
      )
    ).toEqual(["https://example.com/article"]);
  });
});

describe("extractLinkCandidates", () => {
  it("labels a direct URL payload without changing its URL", () => {
    const envelope: InputEnvelope = {
      channel: "web",
      sender_account_id: "account-1",
      channel_message_id: "message-url",
      payload_type: "url",
      raw_payload: "https://example.com/Direct?x=1",
      received_at: "2026-07-31T10:00:00+08:00",
      parser_version: "v1"
    };

    expect(extractLinkCandidates(envelope)).toEqual([
      {
        url: "https://example.com/Direct?x=1",
        source: "url",
        ordinal: 0
      }
    ]);
  });

  it("uses only the structured URL from a link card", () => {
    const envelope: InputEnvelope = {
      channel: "wechat",
      sender_account_id: "account-1",
      channel_message_id: "message-1",
      payload_type: "link_card",
      raw_payload: {
        url: "https://example.com/article",
        title: "标题中出现 https://evil.example",
        description: "描述中出现 https://other.example"
      },
      received_at: "2026-07-31T10:00:00+08:00",
      parser_version: "v1"
    };

    expect(extractLinkCandidates(envelope)).toEqual([
      {
        url: "https://example.com/article",
        source: "link_card",
        ordinal: 0
      }
    ]);
  });
});
