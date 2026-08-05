export const unavailableSummary = "暂时无法生成摘要";

export interface DigestTemplateItem {
  author: string | null;
  originalUrl: string;
  source: string;
  summary: string | null;
  summaryStatus: "failed" | "pending" | "ready" | "unavailable";
  title: string | null;
}

export interface DigestEmailContent {
  html: string;
  subject: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim();
}

function sourceLabel(source: string): string {
  const known: Record<string, string> = {
    douyin: "抖音",
    wechat_official_article: "微信公众号",
    xiaohongshu: "小红书",
  };
  return known[source] ?? (cleanInline(source) || "来源未提供");
}

export function renderDigestEmail(input: {
  domainName: string;
  items: DigestTemplateItem[];
  localDate: string;
  settingsUrl: string;
}): DigestEmailContent {
  const domainName = cleanInline(input.domainName) || "Domain";
  const subject = `Attention ${domainName} 日报 · ${input.localDate}`;
  const htmlItems = input.items
    .map((item) => {
      const title = cleanInline(item.title ?? "") || "未命名内容";
      const author = cleanInline(item.author ?? "") || "未提供";
      const source = sourceLabel(item.source);
      const summary =
        item.summaryStatus === "ready" && item.summary?.trim()
          ? item.summary.trim()
          : unavailableSummary;
      return `<article style="margin:0 0 28px"><h2 style="font-size:18px;margin:0 0 8px">${escapeHtml(title)}</h2><p style="color:#555;margin:0 0 8px">作者：${escapeHtml(author)} · 来源：${escapeHtml(source)}</p><p style="line-height:1.65;margin:0 0 10px">${escapeHtml(summary)}</p><p style="margin:0"><a href="${escapeHtml(item.originalUrl)}">查看原文</a></p></article>`;
    })
    .join("");
  const textItems = input.items
    .map((item, index) => {
      const title = cleanInline(item.title ?? "") || "未命名内容";
      const author = cleanInline(item.author ?? "") || "未提供";
      const summary =
        item.summaryStatus === "ready" && item.summary?.trim()
          ? item.summary.trim()
          : unavailableSummary;
      return `${index + 1}. ${title}\n作者：${author}\n来源：${sourceLabel(item.source)}\n${summary}\n查看原文：${item.originalUrl}`;
    })
    .join("\n\n");
  return {
    html: `<!doctype html><html lang="zh-CN"><body><main style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:24px"><h1>${escapeHtml(domainName)} 日报</h1><p>${escapeHtml(input.localDate)} · 共 ${input.items.length} 条</p>${htmlItems}<footer style="border-top:1px solid #ddd;padding-top:16px"><a href="${escapeHtml(input.settingsUrl)}">管理或退订日报</a></footer></main></body></html>`,
    subject,
    text: `${domainName} 日报\n${input.localDate} · 共 ${input.items.length} 条\n\n${textItems}\n\n管理或退订日报：${input.settingsUrl}`,
  };
}
