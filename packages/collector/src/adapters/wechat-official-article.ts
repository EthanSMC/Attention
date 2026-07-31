import { hostnameIs, parseHttpUrl, type UrlInput } from "../url";
import { createPlatformIdentity } from "./shared";
import {
  type AdapterClassification,
  type AdapterIdentity,
  type SourceAdapter,
  unknownClassification
} from "./types";

const ADAPTER_VERSION = "v1";
const OFFICIAL_ARTICLE_HOST = "mp.weixin.qq.com";

interface WechatArticleIdentity {
  readonly value: string;
  readonly normalizedUrl: string;
}

function articleIdentity(url: URL): WechatArticleIdentity | null {
  if (url.pathname.startsWith("/s/")) {
    const slug = url.pathname.slice(3).replace(/\/+$/u, "");
    if (slug.length === 0) {
      return null;
    }
    return {
      value: `slug:${slug}`,
      normalizedUrl: `https://${OFFICIAL_ARTICLE_HOST}/s/${slug}`
    };
  }

  if (url.pathname !== "/s") {
    return null;
  }

  const biz = url.searchParams.get("__biz");
  const mid = url.searchParams.get("mid");
  const idx = url.searchParams.get("idx");
  if (biz === null || biz.length === 0 || mid === null || idx === null) {
    return null;
  }
  if (!/^\d+$/u.test(mid) || !/^\d+$/u.test(idx)) {
    return null;
  }

  const normalizedQuery = new URLSearchParams([
    ["__biz", biz],
    ["mid", mid],
    ["idx", idx]
  ]);
  return {
    value: `message:${encodeURIComponent(biz)}:${mid}:${idx}`,
    normalizedUrl: `https://${OFFICIAL_ARTICLE_HOST}/s?${normalizedQuery.toString()}`
  };
}

export function detectWechatOfficialArticle(input: UrlInput): boolean {
  const url = parseHttpUrl(input);
  return url !== null && hostnameIs(url, OFFICIAL_ARTICLE_HOST);
}

export function classifyWechatOfficialArticle(
  input: UrlInput
): AdapterClassification {
  const url = parseHttpUrl(input);
  if (url === null || !hostnameIs(url, OFFICIAL_ARTICLE_HOST)) {
    return unknownClassification();
  }

  if (/^\/(?:mp|cgi-bin)(?:\/|$)/u.test(url.pathname)) {
    return { kind: "marketing" };
  }

  const identity = articleIdentity(url);
  return identity === null
    ? unknownClassification()
    : {
        kind: "content",
        contentType: "article",
        externalId: identity.value
      };
}

export function normalizeWechatOfficialArticle(input: UrlInput): string | null {
  const url = parseHttpUrl(input);
  if (url === null || !hostnameIs(url, OFFICIAL_ARTICLE_HOST)) {
    return null;
  }
  return articleIdentity(url)?.normalizedUrl ?? null;
}

export function identifyWechatOfficialArticle(
  input: UrlInput
): AdapterIdentity | null {
  const classification = classifyWechatOfficialArticle(input);
  if (
    classification.kind !== "content" ||
    classification.contentType === undefined ||
    classification.externalId === undefined
  ) {
    return null;
  }

  const normalizedUrl = normalizeWechatOfficialArticle(input);
  if (normalizedUrl === null) {
    return null;
  }

  return createPlatformIdentity({
    adapter: "wechat_official_article",
    adapterVersion: ADAPTER_VERSION,
    contentType: classification.contentType,
    identityValue: classification.externalId,
    normalizedUrl
  });
}

export const wechatOfficialArticleAdapter: SourceAdapter = {
  id: "wechat_official_article",
  version: ADAPTER_VERSION,
  detect: detectWechatOfficialArticle,
  classify: classifyWechatOfficialArticle,
  normalize: normalizeWechatOfficialArticle,
  identity: identifyWechatOfficialArticle
};
