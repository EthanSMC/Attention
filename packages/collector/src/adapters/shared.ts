import type { ContentType, SourceAdapterId } from "@attention/contracts";

import type { AdapterIdentity } from "./types";

export function createPlatformIdentity(input: {
  adapter: SourceAdapterId;
  adapterVersion: string;
  contentType: ContentType;
  identityValue: string;
  normalizedUrl: string;
}): AdapterIdentity {
  return {
    adapter: input.adapter,
    adapterVersion: input.adapterVersion,
    contentType: input.contentType,
    identityKind: "platform_id",
    identityValue: input.identityValue,
    normalizedUrl: input.normalizedUrl,
    dedupeKey: `${input.adapter}:${input.adapterVersion}:${input.identityValue}`
  };
}
