import { describe, expect, it, vi } from "vitest";

import type { ContentHandlerContext } from "./handlers";
import {
  createFetcherDocumentLoader,
  createProductionHandlers,
  extractDocument,
} from "./production-handlers";

function context(overrides: Partial<ContentHandlerContext> = {}): ContentHandlerContext {
  return {
    author: null,
    contentId: "00000000-0000-4000-8000-000000000001",
    outboundUrl: "https://example.com/deep-learning-notes?tracking=secret",
    publishedAt: null,
    signal: new AbortController().signal,
    source: "generic_web",
    title: null,
    ...overrides,
  };
}

describe("production enrichment handlers", () => {
  it("rejects a remote clear-text Fetcher endpoint before sending its bearer secret", () => {
    expect(() => createFetcherDocumentLoader({
      FETCHER_BASE_URL: "http://fetcher.example/v1",
      FETCHER_SHARED_SECRET: "s".repeat(32),
    })).toThrow(/HTTPS/u);
  });

  it("extracts necessary metadata and temporary text without returning HTML", () => {
    const result = extractDocument(`<!doctype html><html><head>
      <meta property="og:title" content="&quot;Grounded&quot; Notes">
      <meta name="author" content="Example Author">
      <meta property="article:published_time" content="2026-08-01T10:00:00Z">
      <meta name="description" content="A useful description">
      <script>privateBody()</script></head><body><p>Visible page text</p></body></html>`);
    expect(result).toMatchObject({
      author: "Example Author",
      description: "A useful description",
      text: "Visible page text",
      title: '"Grounded" Notes',
    });
    expect(result).not.toHaveProperty("html");
  });

  it("completes deterministic metadata and an honest unavailable summary without AI", async () => {
    const handlers = createProductionHandlers();
    await expect(handlers.metadata(context())).resolves.toMatchObject({
      author: null,
      title: "deep learning notes",
    });
    await expect(handlers.summary(context())).resolves.toMatchObject({
      status: "unavailable",
      summary: null,
    });
  });

  it("generates summary and tags from provider output while stripping URL query data", async () => {
    const completeJson = vi.fn().mockResolvedValue({
      summary: "这是一段仅根据可用页面证据生成的摘要。",
      tags: ["AI", "知识管理", "AI"],
    });
    const handlers = createProductionHandlers({
      documentLoader: {
        load: vi.fn().mockResolvedValue({
          finalUrl: "https://example.com/article?private=value",
          html: "<title>Article</title><body>Evidence from the page.</body>",
        }),
      },
      provider: { completeJson },
    });

    await expect(handlers.summary(context())).resolves.toEqual({
      status: "ready",
      summary: "这是一段仅根据可用页面证据生成的摘要。",
      tags: ["AI", "知识管理"],
    });
    const prompt = completeJson.mock.calls[0]?.[0].user as string;
    expect(prompt).toContain("Evidence from the page.");
    expect(prompt).toContain("https://example.com/article");
    expect(prompt).not.toContain("private=value");
  });
});
