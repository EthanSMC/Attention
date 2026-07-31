import { hostnameIsOneOf, parseHttpUrl, type UrlInput } from "../url";
import { createPlatformIdentity } from "./shared";
import {
  type AdapterClassification,
  type AdapterIdentity,
  type SourceAdapter,
  unknownClassification
} from "./types";

const ADAPTER_VERSION = "v1";
const SHORTLINK_HOSTS = new Set(["v.douyin.com"]);
const CONTENT_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com"
]);
const ALL_HOSTS = new Set([...SHORTLINK_HOSTS, ...CONTENT_HOSTS]);
const CONTENT_PATH =
  /^\/(?:share\/)?(?<kind>video|note|slides)\/(?<id>[0-9]+)(?:\/|$)/u;
const DOWNLOAD_PATH = /^\/(?:download|downloadpage)(?:\/|$)/u;
const MARKETING_PATH = /^\/(?:activity|campaign|event)(?:\/|$)/u;

export function detectDouyin(input: UrlInput): boolean {
  const url = parseHttpUrl(input);
  return url !== null && hostnameIsOneOf(url, ALL_HOSTS);
}

export function classifyDouyin(input: UrlInput): AdapterClassification {
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

  const match = CONTENT_PATH.exec(url.pathname);
  const id = match?.groups?.id;
  const kind = match?.groups?.kind;
  if (id === undefined || kind === undefined) {
    return unknownClassification();
  }

  return {
    kind: "content",
    contentType: kind === "video" ? "video" : "note",
    externalId: `${kind === "video" ? "video" : "note"}:${id}`
  };
}

export function normalizeDouyin(input: UrlInput): string | null {
  const classification = classifyDouyin(input);
  if (
    classification.kind !== "content" ||
    classification.externalId === undefined
  ) {
    const url = parseHttpUrl(input);
    return url !== null && hostnameIsOneOf(url, SHORTLINK_HOSTS)
      ? url.href
      : null;
  }

  const [kind, id] = classification.externalId.split(":");
  if (kind === undefined || id === undefined) {
    return null;
  }
  return `https://www.douyin.com/${kind}/${id}`;
}

export function identifyDouyin(input: UrlInput): AdapterIdentity | null {
  const classification = classifyDouyin(input);
  if (
    classification.kind !== "content" ||
    classification.contentType === undefined ||
    classification.externalId === undefined
  ) {
    return null;
  }

  const normalizedUrl = normalizeDouyin(input);
  if (normalizedUrl === null) {
    return null;
  }

  return createPlatformIdentity({
    adapter: "douyin",
    adapterVersion: ADAPTER_VERSION,
    contentType: classification.contentType,
    identityValue: classification.externalId,
    normalizedUrl
  });
}

export const douyinAdapter: SourceAdapter = {
  id: "douyin",
  version: ADAPTER_VERSION,
  detect: detectDouyin,
  classify: classifyDouyin,
  normalize: normalizeDouyin,
  identity: identifyDouyin
};
