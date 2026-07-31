import {
  classifyDouyin,
  classifyWechatOfficialArticle,
  classifyXiaohongshu,
  detectDouyin,
  detectSourceAdapter,
  detectWechatOfficialArticle,
  detectXiaohongshu,
  douyinAdapter,
  genericWebAdapter,
  identifyDouyin,
  identifyGenericWeb,
  identifyWechatOfficialArticle,
  identifyXiaohongshu,
  normalizeDouyin,
  normalizeGenericUrl,
  normalizeWechatOfficialArticle,
  normalizeXiaohongshu,
  wechatOfficialArticleAdapter,
  xiaohongshuAdapter
} from "@attention/collector";
import { collectorFixtures } from "@attention/testkit";
import { describe, expect, it } from "vitest";

describe("source adapter detection", () => {
  it("detects exact platform hosts and routes generic last", () => {
    expect(
      detectSourceAdapter("https://www.douyin.com/video/123456")?.id
    ).toBe("douyin");
    expect(
      detectSourceAdapter(
        "https://www.xiaohongshu.com/explore/64abcdef1234"
      )?.id
    ).toBe("xiaohongshu");
    expect(
      detectSourceAdapter(
        "https://mp.weixin.qq.com/s?__biz=fixture&mid=1&idx=1"
      )?.id
    ).toBe("wechat_official_article");
    expect(detectSourceAdapter("https://example.com/article")?.id).toBe(
      "generic_web"
    );
  });

  it("does not mistake suffix and userinfo spoofing for platform hosts", () => {
    const [douyinSpoof, xhsSpoof, wechatSpoof, userinfoSpoof] =
      collectorFixtures.hostSpoofUrls;

    expect(detectDouyin(douyinSpoof)).toBe(false);
    expect(detectXiaohongshu(xhsSpoof)).toBe(false);
    expect(detectWechatOfficialArticle(wechatSpoof)).toBe(false);
    expect(detectDouyin(userinfoSpoof)).toBe(false);

    expect(detectSourceAdapter(douyinSpoof)?.id).toBe("generic_web");
    expect(detectSourceAdapter(xhsSpoof)?.id).toBe("generic_web");
    expect(detectSourceAdapter(wechatSpoof)?.id).toBe("generic_web");
    expect(detectSourceAdapter(userinfoSpoof)).toBeNull();
  });
});

describe("douyin adapter", () => {
  it("classifies shortlinks without inventing content identity", () => {
    expect(classifyDouyin("https://v.douyin.com/Fixture/").kind).toBe(
      "shortlink"
    );
    expect(identifyDouyin("https://v.douyin.com/Fixture/")).toBeNull();
  });

  it("normalizes path variants and tracking parameters to an item identity", () => {
    const first =
      "https://www.douyin.com/share/video/123456789?previous_page=app";
    const second = "https://douyin.com/video/123456789?utm_source=share";

    expect(normalizeDouyin(first)).toBe(
      "https://www.douyin.com/video/123456789"
    );
    expect(identifyDouyin(first)?.dedupeKey).toBe(
      identifyDouyin(second)?.dedupeKey
    );
  });

  it("classifies known non-content pages before generic fallback", () => {
    expect(classifyDouyin("https://www.douyin.com/downloadpage").kind).toBe(
      "download"
    );
  });
});

describe("xiaohongshu adapter", () => {
  it("normalizes explore and discovery paths to the same note identity", () => {
    const explore =
      "https://www.xiaohongshu.com/explore/64abcdef1234?xsec_token=sensitive";
    const discovery =
      "https://xiaohongshu.com/discovery/item/64abcdef1234?source=share";

    expect(normalizeXiaohongshu(discovery)).toBe(
      "https://www.xiaohongshu.com/explore/64abcdef1234"
    );
    expect(identifyXiaohongshu(explore)?.dedupeKey).toBe(
      identifyXiaohongshu(discovery)?.dedupeKey
    );
    expect(classifyXiaohongshu(explore).contentType).toBe("note");
  });
});

describe("WeChat official article adapter", () => {
  it("keeps only the versioned article identity tuple", () => {
    const first =
      "https://mp.weixin.qq.com/s?idx=1&sn=first&mid=123456&__biz=MzFixture%3D%3D&chksm=tracking";
    const second =
      "https://mp.weixin.qq.com/s?__biz=MzFixture%3D%3D&mid=123456&idx=1&sn=second";

    expect(normalizeWechatOfficialArticle(first)).toBe(
      "https://mp.weixin.qq.com/s?__biz=MzFixture%3D%3D&mid=123456&idx=1"
    );
    expect(identifyWechatOfficialArticle(first)?.dedupeKey).toBe(
      identifyWechatOfficialArticle(second)?.dedupeKey
    );
    expect(classifyWechatOfficialArticle(first).contentType).toBe("article");
  });

  it("supports clean /s/:slug article URLs", () => {
    expect(
      identifyWechatOfficialArticle(
        "https://mp.weixin.qq.com/s/public-article-slug?scene=1"
      )?.identityValue
    ).toBe("slug:public-article-slug");
  });
});

describe("conservative generic normalization", () => {
  it("normalizes only scheme, host and default port", () => {
    expect(
      normalizeGenericUrl(
        "HTTPS://Example.COM.:443/Path/%2F?b=2&a=1#Section"
      )
    ).toBe("https://example.com/Path/%2F?b=2&a=1#Section");
  });

  it("preserves query order, path case and fragments in identity", () => {
    const first = identifyGenericWeb(
      "https://example.com/Path?a=1&b=2#first"
    );
    const reordered = identifyGenericWeb(
      "https://example.com/Path?b=2&a=1#first"
    );
    const pathCase = identifyGenericWeb(
      "https://example.com/path?a=1&b=2#first"
    );
    const fragment = identifyGenericWeb(
      "https://example.com/Path?a=1&b=2#second"
    );

    expect(first?.dedupeKey).not.toBe(reordered?.dedupeKey);
    expect(first?.dedupeKey).not.toBe(pathCase?.dedupeKey);
    expect(first?.dedupeKey).not.toBe(fragment?.dedupeKey);
  });

  it("rejects credentials and non-HTTP schemes", () => {
    expect(normalizeGenericUrl("https://user:pass@example.com/private")).toBeNull();
    expect(normalizeGenericUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("adapter purity contract", () => {
  it("returns values synchronously and exposes no network capability", () => {
    for (const adapter of [
      douyinAdapter,
      xiaohongshuAdapter,
      wechatOfficialArticleAdapter,
      genericWebAdapter
    ]) {
      expect(adapter.detect("https://example.com")).not.toBeInstanceOf(Promise);
      expect(adapter.classify("https://example.com")).not.toBeInstanceOf(
        Promise
      );
    }
  });
});
