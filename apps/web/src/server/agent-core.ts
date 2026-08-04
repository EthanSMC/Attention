export interface AgentCandidate {
  author: string | null;
  href: string;
  id: string;
  key: string;
  scope: "mine" | "public";
  source: string;
  summary: string | null;
  tags: string[];
  title: string;
}

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
  mode: "deterministic" | "generated";
}

export interface AgentAnswerProvider {
  answer(input: {
    query: string;
    sources: AgentCandidate[];
  }): Promise<{ answer: string; citedSourceKeys: string[] }>;
}

export class AgentAccessError extends Error {
  readonly code = "membership_required";

  constructor() {
    super("membership_required");
    this.name = "AgentAccessError";
  }
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

function scoreCandidate(candidate: AgentCandidate, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = candidate.title.toLocaleLowerCase("zh-CN");
  const tags = candidate.tags.join(" ").toLocaleLowerCase("zh-CN");
  const summary = candidate.summary?.toLocaleLowerCase("zh-CN") ?? "";
  const source = `${candidate.source} ${candidate.author ?? ""}`.toLocaleLowerCase("zh-CN");
  return terms.reduce((score, term) => {
    if (title.includes(term)) return score + 8;
    if (tags.includes(term)) return score + 6;
    if (source.includes(term)) return score + 3;
    if (summary.includes(term)) return score + 2;
    return score;
  }, 0);
}

export function rankAgentCandidates(
  query: string,
  candidates: AgentCandidate[],
): AgentCandidate[] {
  const terms = queryTerms(query);
  const unique = new Map<string, AgentCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.key);
    if (!existing || (candidate.scope === "mine" && existing.scope === "public")) {
      unique.set(candidate.key, candidate);
    }
  }
  return [...unique.values()]
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.candidate.scope === "mine") - Number(left.candidate.scope === "mine"))
    .slice(0, 8)
    .map((entry) => entry.candidate);
}

function citation(candidate: AgentCandidate): AgentCitation {
  return {
    author: candidate.author,
    href: candidate.href,
    id: candidate.id,
    scope: candidate.scope,
    source: candidate.source,
    title: candidate.title,
  };
}

function deterministicResult(ranked: AgentCandidate[]): AgentRetrievalResult {
  if (ranked.length === 0) {
    return {
      answer: "暂时没有找到足够匹配的收藏。可以换一个更具体的主题、作者或来源再问一次。",
      citations: [],
      mode: "deterministic",
    };
  }
  const highlights = ranked.slice(0, 3).map((candidate, index) => {
    const detail = candidate.summary?.trim() || `${candidate.source}${candidate.author ? ` · ${candidate.author}` : ""}`;
    return `${index + 1}. ${candidate.title} — ${detail}`;
  });
  return {
    answer: `关键词检索找到 ${ranked.length} 条相关收藏：\n${highlights.join("\n")}\n请通过引用打开原文核对。`,
    citations: ranked.map(citation),
    mode: "deterministic",
  };
}

export async function answerAgentQuery(input: {
  candidates: AgentCandidate[];
  isMember: boolean;
  provider?: AgentAnswerProvider | null;
  query: string;
}): Promise<AgentRetrievalResult> {
  if (!input.isMember) throw new AgentAccessError();
  const ranked = rankAgentCandidates(input.query, input.candidates);
  if (ranked.length === 0 || !input.provider) return deterministicResult(ranked);

  try {
    const generated = await input.provider.answer({ query: input.query, sources: ranked });
    const answer = generated.answer.trim();
    const byKey = new Map(ranked.map((candidate) => [candidate.key, candidate]));
    const citedKeys = [...new Set(generated.citedSourceKeys)];
    const selected = citedKeys.map((key) => byKey.get(key));
    if (!answer || answer.length > 4_000 || selected.length === 0 ||
      selected.some((candidate) => candidate === undefined)) {
      return deterministicResult(ranked);
    }
    return {
      answer,
      citations: selected.map((candidate) => citation(candidate!)),
      mode: "generated",
    };
  } catch {
    return deterministicResult(ranked);
  }
}
