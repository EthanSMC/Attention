import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PublicContent } from "../lib/attention";
import { ContentCardBody } from "./content-card";
import { EnrichmentBadge } from "./signal-elements";

const baseContent: PublicContent = {
  author: "Attention",
  filters: [],
  firstPublicAt: "2026-08-12T00:00:00.000Z",
  id: "content-1",
  outboundHref: "/out/mine/collection-1",
  publishedAt: null,
  source: "网页",
  sourceInitial: "网",
  sourceTone: "gold",
  summary: null,
  summaryStatus: "processing",
  tags: [],
  title: "测试内容",
};

describe("content enrichment presentation", () => {
  it("renders pending enrichment as a neutral completion state", () => {
    const badge = renderToStaticMarkup(
      createElement(EnrichmentBadge, { status: "processing" }),
    );
    const card = renderToStaticMarkup(
      createElement(ContentCardBody, {
        collectedAt: "2026-08-12T00:00:00.000Z",
        content: baseContent,
      }),
    );

    expect(badge).toContain("摘要待补全");
    expect(badge).toContain("status-label--processing");
    expect(badge).not.toContain("status-label--unavailable");
    expect(badge).not.toContain('d="m12 3 9 17H3L12 3Z"');
    expect(card).toContain("摘要仍在补全，原文已可查看。");
    expect(card).not.toContain("当前没有可用的 AI 摘要");
  });

  it("keeps a ready summary and its success signal unchanged", () => {
    const badge = renderToStaticMarkup(
      createElement(EnrichmentBadge, { status: "ready" }),
    );
    const card = renderToStaticMarkup(
      createElement(ContentCardBody, {
        collectedAt: "2026-08-12T00:00:00.000Z",
        content: {
          ...baseContent,
          summary: "这是一份已经完成的摘要。",
          summaryStatus: "ready",
        },
      }),
    );

    expect(badge).toContain("AI 摘要可用");
    expect(badge).toContain("status-label--ready");
    expect(card).toContain("这是一份已经完成的摘要。");
  });

  it("keeps a genuine terminal unavailable state distinct", () => {
    const badge = renderToStaticMarkup(
      createElement(EnrichmentBadge, { status: "unavailable" }),
    );
    const card = renderToStaticMarkup(
      createElement(ContentCardBody, {
        collectedAt: "2026-08-12T00:00:00.000Z",
        content: { ...baseContent, summaryStatus: "unavailable" },
      }),
    );

    expect(badge).toContain("无可用摘要");
    expect(badge).toContain("status-label--unavailable");
    expect(badge).toContain('d="m12 3 9 17H3L12 3Z"');
    expect(card).toContain("当前没有可用的 AI 摘要，请查看原文。");
    expect(card).not.toContain("摘要待补全");
  });
});
