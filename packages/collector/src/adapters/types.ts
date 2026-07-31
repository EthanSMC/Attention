import type { ContentType, SourceAdapterId } from "@attention/contracts";

import type { UrlInput } from "../url";

export type AdapterClassificationKind =
  | "content"
  | "shortlink"
  | "download"
  | "marketing"
  | "unknown";

export interface AdapterClassification {
  readonly kind: AdapterClassificationKind;
  readonly contentType?: ContentType;
  readonly externalId?: string;
}

export interface AdapterIdentity {
  readonly adapter: SourceAdapterId;
  readonly adapterVersion: string;
  readonly contentType: ContentType;
  readonly identityKind: "platform_id" | "normalized_url";
  readonly identityValue: string;
  readonly normalizedUrl: string;
  readonly dedupeKey: string;
}

/**
 * Deliberately synchronous and value-only: adapters classify identity and do
 * not receive an HTTP client, resolver, document or other network capability.
 */
export interface SourceAdapter {
  readonly id: SourceAdapterId;
  readonly version: string;
  detect(input: UrlInput): boolean;
  classify(input: UrlInput): AdapterClassification;
  normalize(input: UrlInput): string | null;
  identity(input: UrlInput): AdapterIdentity | null;
}

export function unknownClassification(): AdapterClassification {
  return { kind: "unknown" };
}
