import { hostnameIsOneOf, parseHttpUrl, type UrlInput } from "../url";
import { createPlatformIdentity } from "./shared";
import {
  type AdapterClassification,
  type AdapterIdentity,
  type SourceAdapter,
  unknownClassification
} from "./types";

const ADAPTER_VERSION = "v1";
const SHORTLINK_HOSTS = new Set(["xhslink.com", "www.xhslink.com"]);
const CONTENT_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);
const ALL_HOSTS = new Set([...SHORTLINK_HOSTS, ...CONTENT_HOSTS]);
const CONTENT_PATH =
  /^\/(?:explore|discovery\/item)\/(?<id>[A-Za-z0-9_-]{6,128})(?:\/|$)/u;
const DOWNLOAD_PATH = /^\/(?:download|download-app)(?:\/|$)/u;
const MARKETING_PATH = /^\/(?:activity|campaign|event|events)(?:\/|$)/u;

export function detectXiaohongshu(input: UrlInput): boolean {
  const url = parseHttpUrl(input);
  return url !== null && hostnameIsOneOf(url, ALL_HOSTS);
}

export function classifyXiaohongshu(
  input: UrlInput
): AdapterClassification {
  const url = parseHttpUrl(input);
  if (url === null || !hostnameIsOneOf(url, ALL_HOSTS)) {
    return unknownClassification();
  }

  if (DOWNLOAD_PATH.test(url.pathname)) {
    return { kind: "download" };
  }
  if (MARKETING_PATH.test(url.pathname)) {
    return { kind: "marketing" };
  }
  if (hostnameIsOneOf(url, SHORTLINK_HOSTS)) {
    return { kind: "shortlink" };
  }

  const id = CONTENT_PATH.exec(url.pathname)?.groups?.id;
  return id === undefined
    ? unknownClassification()
    : { kind: "content", contentType: "note", externalId: `note:${id}` };
}

export function normalizeXiaohongshu(input: UrlInput): string | null {
  const classification = classifyXiaohongshu(input);
  if (
    classification.kind !== "content" ||
    classification.externalId === undefined
  ) {
    const url = parseHttpUrl(input);
    return url !== null && hostnameIsOneOf(url, SHORTLINK_HOSTS)
      ? url.href
      : null;
  }

  const id = classification.externalId.slice("note:".length);
  return `https://www.xiaohongshu.com/explore/${id}`;
}

export function identifyXiaohongshu(input: UrlInput): AdapterIdentity | null {
  const classification = classifyXiaohongshu(input);
  if (
    classification.kind !== "content" ||
    classification.contentType === undefined ||
    classification.externalId === undefined
  ) {
    return null;
  }

  const normalizedUrl = normalizeXiaohongshu(input);
  if (normalizedUrl === null) {
    return null;
  }

  return createPlatformIdentity({
    adapter: "xiaohongshu",
    adapterVersion: ADAPTER_VERSION,
    contentType: classification.contentType,
    identityValue: classification.externalId,
    normalizedUrl
  });
}

export const xiaohongshuAdapter: SourceAdapter = {
  id: "xiaohongshu",
  version: ADAPTER_VERSION,
  detect: detectXiaohongshu,
  classify: classifyXiaohongshu,
  normalize: normalizeXiaohongshu,
  identity: identifyXiaohongshu
};
