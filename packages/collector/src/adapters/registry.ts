import type { UrlInput } from "../url";
import { douyinAdapter } from "./douyin";
import { genericWebAdapter } from "./generic-web";
import type { AdapterClassification, SourceAdapter } from "./types";
import { wechatOfficialArticleAdapter } from "./wechat-official-article";
import { xiaohongshuAdapter } from "./xiaohongshu";

/** Specific adapters are ordered before the generic fallback. */
export const sourceAdapters: readonly SourceAdapter[] = Object.freeze([
  douyinAdapter,
  xiaohongshuAdapter,
  wechatOfficialArticleAdapter,
  genericWebAdapter
]);

export interface AdapterMatch {
  readonly adapter: SourceAdapter;
  readonly classification: AdapterClassification;
}

export function detectSourceAdapter(input: UrlInput): SourceAdapter | null {
  return sourceAdapters.find((adapter) => adapter.detect(input)) ?? null;
}

export function classifySourceUrl(input: UrlInput): AdapterMatch | null {
  const adapter = detectSourceAdapter(input);
  return adapter === null
    ? null
    : { adapter, classification: adapter.classify(input) };
}
