import "server-only";

import type { AttentionDatabase } from "@attention/db";

import type { PublicContent } from "../lib/attention";
import { loadMyCollections, loadPublicContents } from "./content-queries";

export interface AgentCitation {
  author: string | null;
  href: string;
  id: string;
  scope: "mine" | "public";
  source: string;
  title: string;
}

export interface AgentRetrievalResult {
  answer: string;
  citations: AgentCitation[];
}

const stopWords = new Set([
  "一个", "一些", "上次", "之前", "关于", "好像", "文章", "内容", "来着", "可以",
  "什么", "我的", "我想", "看看", "找到", "收藏", "the", "and", "for", "with",
]);

function queryTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const rough = normalized.match(/[\p{Script=Han}]{2,}|[a-z0-9][a-z0-9+._-]{1,}/gu) ?? [];
  const terms = new Set<string>();
  for (const token of rough) {
    if (!stopWords.has(token)) terms.add(token);
    if (/^[\p{Script=Han}]{4,}$/u.test(token)) {
      for (let index = 0; index < token.length - 1; index += 1) {
        const pair = token.slice(index, index + 2);
        if (!stopWords.has(pair)) terms.add(pair);
      }
    }
  }
  return [...terms].slice(0, 16);
}

function scoreContent(content: PublicContent, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = content.title.toLocaleLowerCase("zh-CN");
  const summary = content.summary?.toLocaleLowerCase("zh-CN") ?? "";
  const source = `${content.source} ${content.author ?? ""}`.toLocaleLowerCase("zh-CN");
  return terms.reduce((score, term) => {
    if (title.includes(term)) return score + 8;
    if (source.includes(term)) return score + 3;
    if (summary.includes(term)) return score + 2;
    return score;
  }, 0);
}

export async function retrieveForAgent(
  db: AttentionDatabase,
  accountId: string,
  query: string,
): Promise<AgentRetrievalResult> {
  const [mine, publicContents] = await Promise.all([
    loadMyCollections(db, accountId),
    loadPublicContents(db),
  ]);
  const terms = queryTerms(query);
  const ranked = [
    ...mine.map((content) => ({ content, scope: "mine" as const })),
    ...publicContents
      .filter((content) => !mine.some((item) => item.id === content.id))
      .map((content) => ({ content, scope: "public" as const })),
  ]
    .map((entry) => ({ ...entry, score: scoreContent(entry.content, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  const citations = ranked.flatMap<AgentCitation>((entry) =>
    entry.content.outboundHref
      ? [{
          author: entry.content.author,
          href: entry.content.outboundHref,
          id: entry.content.id,
          scope: entry.scope,
          source: entry.content.source,
          title: entry.content.title,
        }]
      : [],
  );
  if (citations.length === 0) {
    return {
      answer: "暂时没有找到足够匹配的收藏。可以换一个更具体的主题、作者或来源再问一次。",
      citations: [],
    };
  }
  return {
    answer: `我找到了 ${citations.length} 条可能相关的收藏，自己的收藏排在公开内容之前。请从引用打开原文确认。`,
    citations,
  };
}
