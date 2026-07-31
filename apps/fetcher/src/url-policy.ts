import { isIP } from "node:net";

import { FetcherError } from "./errors.js";
import { isPublicAddress, isUnsafeHostname } from "./ip-policy.js";

export type SourceKind =
  | "douyin"
  | "xiaohongshu"
  | "wechat_official_article"
  | "generic_web";

const SENSITIVE_PARAMETER = /(?:^|[_-])(?:access[_-]?token|token|auth|authorization|credential|password|passwd|secret|signature|signed|sig|api[_-]?key|private[_-]?key|key)(?:$|[_-])/i;

const XIAOHONGSHU_CONTENT_HOSTS = new Set([
  "xiaohongshu.com",
  "www.xiaohongshu.com"
]);
const XIAOHONGSHU_CONTENT_PATH =
  /^\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]{6,128}(?:\/|$)/u;

function allowedQueryParameters(url: URL, sourceKind: SourceKind): ReadonlySet<string> {
  const hostname = url.hostname.toLowerCase().replace(/\.+$/u, "");
  if (
    sourceKind === "xiaohongshu" &&
    XIAOHONGSHU_CONTENT_HOSTS.has(hostname) &&
    XIAOHONGSHU_CONTENT_PATH.test(url.pathname)
  ) {
    return new Set(["xsec_token", "xsec_source"]);
  }
  if (
    sourceKind === "wechat_official_article" &&
    hostname === "mp.weixin.qq.com" &&
    (url.pathname === "/s" || url.pathname.startsWith("/s/"))
  ) {
    return new Set(["__biz", "mid", "idx", "sn", "chksm"]);
  }
  return new Set<string>();
}

function fragmentParameterNames(url: URL): string[] {
  if (url.hash.length <= 1) return [];
  const raw = url.hash.slice(1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Inspect the raw representation if percent decoding is malformed.
  }

  const names = new Set<string>();
  for (const fragment of new Set([raw, decoded])) {
    const queryStart = fragment.indexOf("?");
    const queryLike = queryStart >= 0 ? fragment.slice(queryStart + 1) : fragment;
    for (const key of new URLSearchParams(queryLike.replace(/^[#&?]+/u, "")).keys()) {
      names.add(key.toLowerCase());
    }
  }
  return [...names];
}

export function parseAndValidateUrl(raw: string, sourceKind: SourceKind): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetcherError("invalid_url", "URL could not be parsed");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FetcherError("unsupported_protocol", "Only HTTP(S) is allowed");
  }

  if (url.username || url.password) {
    throw new FetcherError("unsafe_credentials", "URL user information is not allowed");
  }

  const effectivePort = url.port || (url.protocol === "https:" ? "443" : "80");
  if (effectivePort !== "80" && effectivePort !== "443") {
    throw new FetcherError("unsupported_port", "Only ports 80 and 443 are allowed");
  }

  if (!url.hostname || isUnsafeHostname(url.hostname)) {
    throw new FetcherError("unsafe_hostname", "Hostname is not publicly routable");
  }

  if (isIP(url.hostname) !== 0 && !isPublicAddress(url.hostname)) {
    throw new FetcherError("unsafe_address", "IP address is not publicly routable");
  }

  const allowedParameters = allowedQueryParameters(url, sourceKind);
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (SENSITIVE_PARAMETER.test(normalized) && !allowedParameters.has(normalized)) {
      throw new FetcherError("unsafe_credentials", "URL appears to contain credentials");
    }
  }

  for (const normalized of fragmentParameterNames(url)) {
    if (SENSITIVE_PARAMETER.test(normalized)) {
      throw new FetcherError("unsafe_credentials", "URL fragment appears to contain credentials");
    }
  }

  return url;
}

export function assertNoHttpsDowngrade(from: URL, to: URL): void {
  if (from.protocol === "https:" && to.protocol === "http:") {
    throw new FetcherError("https_downgrade", "HTTPS redirects may not downgrade to HTTP");
  }
}
