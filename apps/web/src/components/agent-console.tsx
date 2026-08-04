"use client";

import { useState, type FormEvent } from "react";

interface AgentResult {
  answer: string;
  citations: Array<{
    author: string | null;
    href: string;
    id: string;
    scope: "mine" | "public";
    source: string;
    title: string;
  }>;
  mode: "deterministic" | "generated";
}

export function AgentConsole() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setResult(null);
    const response = await fetch("/api/agent/query", {
      body: JSON.stringify({ query: data.get("query") }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = (await response.json().catch(() => null)) as AgentResult | null;
    setBusy(false);
    if (!response.ok || !body) {
      setError("这次检索没有完成，请稍后重试。");
      return;
    }
    setResult(body);
  }

  return (
    <section className="agent-console">
      <form className="agent-composer" onSubmit={ask}>
        <label className="sr-only" htmlFor="agent-query">询问你的收藏</label>
        <textarea
          autoFocus
          id="agent-query"
          maxLength={500}
          name="query"
          placeholder="例如：我上次收藏的一个关于 MCP 安全的文章是什么？"
          required
          rows={3}
        />
        <button className="button button--primary" disabled={busy} type="submit">
          {busy ? "正在检索…" : "询问 Attention"}
        </button>
      </form>
      {error ? <p aria-live="polite" className="field-error">{error}</p> : null}
      {result ? (
        <div className="agent-answer" aria-live="polite">
          <small>{result.mode === "generated" ? "AI 基于引用生成" : "关键词检索降级"}</small>
          <p>{result.answer}</p>
          {result.citations.length > 0 ? (
            <ol>
              {result.citations.map((citation) => (
                <li key={`${citation.scope}-${citation.id}`}>
                  <a href={citation.href} rel="noopener noreferrer" target="_blank">
                    <strong>{citation.title}</strong>
                    <span>{citation.source}{citation.author ? ` · ${citation.author}` : ""} · {citation.scope === "mine" ? "我的收藏" : "公开收藏"}</span>
                  </a>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
