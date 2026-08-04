import { describe, expect, it } from "vitest";

import { renderDigestEmail, unavailableSummary } from "./digest-template";

describe("daily digest template", () => {
  it("always includes author, source and original link with the exact summary fallback", () => {
    const email = renderDigestEmail({
      domainName: "AI",
      items: [
        {
          author: null,
          originalUrl: "https://attention.example/out/public/00000000-0000-4000-8000-000000000001",
          source: "wechat_official_article",
          summary: null,
          summaryStatus: "unavailable",
          title: "一篇文章",
        },
      ],
      localDate: "2026-08-04",
      settingsUrl: "https://attention.example/account/digests",
    });
    expect(email.subject).toBe("Attention AI 日报 · 2026-08-04");
    expect(email.html).toContain("作者：未提供");
    expect(email.html).toContain("来源：微信公众号");
    expect(email.html).toContain(unavailableSummary);
    expect(email.html).toContain("查看原文");
    expect(email.text).toContain("查看原文：https://attention.example/out/public/");
    expect(email.text).toContain("管理或退订日报：https://attention.example/account/digests");
  });

  it("escapes untrusted metadata in HTML", () => {
    const email = renderDigestEmail({
      domainName: "AI<script>",
      items: [
        {
          author: '<img src=x onerror="alert(1)">',
          originalUrl: "https://attention.example/out/public/id?x=1&y=2",
          source: "<source>",
          summary: "<b>unsafe</b>",
          summaryStatus: "ready",
          title: "<script>alert(1)</script>",
        },
      ],
      localDate: "2026-08-04",
      settingsUrl: "https://attention.example/account/digests",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("x=1&amp;y=2");
  });
});
