import { createElement } from "react";
import { readFileSync } from "node:fs";
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
    expect(badge).toContain('data-enrichment-icon="assistant"');
    expect(badge).not.toContain('data-enrichment-icon="warning"');
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
    expect(badge).toContain('data-enrichment-icon="warning"');
    expect(card).toContain("当前没有可用的 AI 摘要，请查看原文。");
    expect(card).not.toContain("摘要待补全");
  });

  it("keeps every processing badge rule on neutral design tokens", () => {
    const css = readFileSync(
      new URL("../app/globals.css", import.meta.url),
      "utf8",
    );
    const blocks = [...css.matchAll(/\.status-label--processing\s*\{(?<body>[^}]+)\}/gu)]
      .map((match) => match.groups?.body ?? "");

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const tokens = [...block.matchAll(/var\((--[^)]+)\)/gu)]
        .map((match) => match[1]);
      expect(tokens).toContain("--surface-muted");
      expect(tokens).toContain("--muted");
      expect(tokens.every((token) =>
        ["--line", "--surface-muted", "--muted"].includes(token ?? "")))
        .toBe(true);
      expect(block).not.toMatch(/--(?:ai|danger|warning)|#[0-9a-f]{3,8}|rgba?\(/iu);
    }
  });
});
