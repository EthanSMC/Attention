import { describe, expect, it } from "vitest";

import { extractDocument } from "./production-handlers";

describe("document extraction", () => {
  it.each(["", "Loading article…"])("recovers JSON-LD from a rendering shell showing %j", (placeholder) => {
    const result = extractDocument(`<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Publisher, not the article" },
          {
            "@type": ["CreativeWork", "NewsArticle"],
            headline: "结构化文章标题",
            author: [{ "@type": "Person", name: "作者甲" }, { name: "作者乙" }],
            datePublished: "2026-08-01T10:00:00Z",
            description: "文章的结构化简介",
            articleBody: "这是结构化数据中保存的文章正文，不能随着脚本一起丢掉。",
          },
        ],
      })}</script>
      <script>window.privateState = "Do not include executable scripts";</script>
      </head><body><div id="app">${placeholder}</div></body></html>`);

    expect(result).toEqual({
      title: "结构化文章标题",
      author: "作者甲, 作者乙",
      publishedAt: new Date("2026-08-01T10:00:00Z"),
      description: "文章的结构化简介",
      text: "这是结构化数据中保存的文章正文，不能随着脚本一起丢掉。",
    });
  });

  it("extracts the article before applying the text limit so navigation cannot crowd it out", () => {
    const result = extractDocument(`<html><head><title>正文测试</title></head><body>
      <nav>${'<a href="/menu">站点导航和推荐链接</a>'.repeat(2000)}</nav>
      <article><h1>正文测试</h1><p>真正的正文从这里开始。</p>
        <p>${"这是文章的论述与证据，需要被完整识别为正文。".repeat(800)}</p>
      </article><footer>页脚信息</footer></body></html>`);

    expect(result.text).toContain("真正的正文从这里开始。");
    expect(result.text).not.toContain("站点导航和推荐链接");
    expect(result.text).not.toContain("页脚信息");
    expect(result.text?.length).toBeLessThanOrEqual(12_000);
  });

  it("keeps a short main section with word boundaries while excluding hidden and executable content", () => {
    const result = extractDocument(`<html><head><title>A &amp; B</title></head><body>
      <nav>Navigation noise</nav><main><p>First paragraph.</p><p>Second paragraph.</p>
      <div hidden>Hidden noise</div><div aria-hidden="true">Invisible noise</div>
      <script>throw new Error("must never run")</script><style>.noise {}</style>
      </main><aside>Related noise</aside></body></html>`);

    expect(result.title).toBe("A & B");
    expect(result.text).toBe("First paragraph. Second paragraph.");
  });

  it("falls back to HTML metadata when structured data is malformed or describes a different kind of entity", () => {
    const result = extractDocument(`<html><head>
      <script type="application/ld+json">{broken JSON</script>
      <script type="application/ld+json">{"@type":"Organization","name":"Wrong title","description":"Wrong description"}</script>
      <meta property="og:title" content="A > B &amp; C">
      <meta name="author" content="HTML Author">
      <meta name="description" content="HTML description">
      <meta property="article:published_time" content="not a date">
      </head><body><p>Plain article text.</p></body></html>`);

    expect(result).toEqual({
      title: "A > B & C",
      author: "HTML Author",
      description: "HTML description",
      publishedAt: null,
      text: "Plain article text.",
    });
  });

  it("does not treat a page containing only navigation as article evidence", () => {
    expect(extractDocument("<html><body><nav>Home Login Subscribe</nav></body></html>").text)
      .toBeNull();
  });

  it("does not treat a title-only HTML fragment as article evidence", () => {
    expect(extractDocument("<title>Loading</title>")).toMatchObject({
      title: "Loading",
      text: null,
    });
  });

  it.each(["Loading article…", "正在加载…"])("does not treat %j alone as article evidence", (placeholder) => {
    expect(extractDocument(`<html><body><div id="app">${placeholder}</div></body></html>`).text)
      .toBeNull();
  });

  it("keeps the visible article when JSON-LD only contains a shorter excerpt", () => {
    const result = extractDocument(`<html><head><script type="application/ld+json">
      {"@type":"Article","articleBody":"Short excerpt."}
      </script></head><body><article><p>The complete article contains concrete evidence beyond the short excerpt.</p>
      </article></body></html>`);
    expect(result.text).toBe("The complete article contains concrete evidence beyond the short excerpt.");
  });
});
