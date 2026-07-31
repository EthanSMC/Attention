import { normalizeGenericUrl, parseHttpUrl, type UrlInput } from "../url";
import {
  type AdapterClassification,
  type AdapterIdentity,
  type SourceAdapter,
  unknownClassification
} from "./types";

const ADAPTER_VERSION = "v1";

export function detectGenericWeb(input: UrlInput): boolean {
  return parseHttpUrl(input) !== null;
}

export function classifyGenericWeb(input: UrlInput): AdapterClassification {
  return detectGenericWeb(input)
    ? { kind: "content", contentType: "web_page" }
    : unknownClassification();
}

export function identifyGenericWeb(input: UrlInput): AdapterIdentity | null {
  const normalizedUrl = normalizeGenericUrl(input);
  if (normalizedUrl === null) {
    return null;
  }

  return {
    adapter: "generic_web",
    adapterVersion: ADAPTER_VERSION,
    contentType: "web_page",
    identityKind: "normalized_url",
    identityValue: normalizedUrl,
    normalizedUrl,
    dedupeKey: `generic_web:${ADAPTER_VERSION}:url:${normalizedUrl}`
  };
}

export const genericWebAdapter: SourceAdapter = {
  id: "generic_web",
  version: ADAPTER_VERSION,
  detect: detectGenericWeb,
  classify: classifyGenericWeb,
  normalize: normalizeGenericUrl,
  identity: identifyGenericWeb
};
