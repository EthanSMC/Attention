"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { canApplyWebsiteSessionUpdate, websiteSessionIdToLoad } from "./website-agent-session-state";

type SessionSummary = { id: string; revision: number; status: "open" | "closed" | "expired"; createdAt: string; updatedAt: string; expiresAt: string };
type SessionView = SessionSummary & { messages: Array<{ role: "user" | "assistant"; text: string }>; pending: { query: string; runId: string; deadline: string } | null };
interface WebsiteAgentReply {
  answer: string;
  session: SessionView;
  usage: { modelCalls: number; toolCalls: number; observedCostMicrousd: number };
}
const errorMessages: Record<string, string> = {
  authentication_required: "请重新登录后再使用。",
  membership_required: "当前账号没有网页助手所需的 Member 权益。",
  website_agent_daily_budget_exhausted: "今天的助手额度已用完，请明天再试。",
  website_agent_busy: "还有一个请求尚未结束，请稍后刷新会话。",
  operation_already_used: "这次请求已经提交过，请先刷新会话并查看收藏状态。",
  budget_exceeded: "这次请求已达到单次处理上限，请缩短问题后再试。",
  session_not_found: "会话不存在或不属于当前账号。",
  session_closed: "这个会话已结束，请新建会话。",
  session_expired: "这个会话已过期，请新建会话。",
  session_conflict: "会话已更新，请刷新后继续，避免重复操作。",
  session_full: "这个会话已达到存储上限，请新建会话。",
  timeout: "这次请求已超时。已保存的收藏不会撤销，请先刷新会话并查看收藏状态。",
};
function messageFor(code?: string): string {
  return errorMessages[code ?? ""] ?? "这次操作没有完成，请刷新会话。若包含保存操作，请先查看我的收藏。";
}
function validSession(value: unknown): value is SessionView {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<SessionView>;
  return typeof session.id === "string" && typeof session.revision === "number" && Array.isArray(session.messages) &&
    session.messages.every(message => (message.role === "user" || message.role === "assistant") && typeof message.text === "string");
}

export function WebsiteAgentConsole() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState<WebsiteAgentReply | null>(null);
  const [pendingQuery, setPendingQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const remember = useCallback((view: SessionView) => {
    setSelected(view);
    setSessions(previous => [view, ...previous.filter(session => session.id !== view.id)]);
    const url = new URL(window.location.href);
    url.searchParams.set("session", view.id);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const fetchView = useCallback(async (id: string, signal?: AbortSignal): Promise<SessionView> => {
    const response = await fetch(`/api/website-agent/sessions/${encodeURIComponent(id)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    const body = await response.json() as { session?: unknown; error?: { code?: string } };
    if (!response.ok || !validSession(body.session)) throw new Error(messageFor(body.error?.code));
    return body.session;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    void (async () => {
      try {
        const response = await fetch("/api/website-agent/sessions", { cache: "no-store", signal: controller.signal });
        const body = await response.json() as { sessions?: SessionSummary[]; error?: { code?: string } };
        if (!response.ok || !Array.isArray(body.sessions)) throw new Error(messageFor(body.error?.code));
        if (current !== generation.current) return;
        setSessions(body.sessions);
        const requested = new URL(window.location.href).searchParams.get("session");
        const id = websiteSessionIdToLoad(requested, body.sessions);
        if (id) {
          const view = await fetchView(id, controller.signal);
          if (current === generation.current) remember(view);
        }
      } catch (failure) {
        if (!controller.signal.aborted && current === generation.current) setError(failure instanceof Error ? failure.message : messageFor());
      } finally { if (current === generation.current) setLoading(false); }
    })();
    return () => { generation.current += 1; controller.abort(); active.current?.abort(); };
  }, [fetchView, remember]);

  useEffect(() => {
    if (!selected?.pending || busy) return;
    const controller = new AbortController();
    const id = selected.id;
    const current = generation.current;
    let inflight = false;
    const timer = setInterval(() => {
      if (inflight || controller.signal.aborted) return;
      inflight = true;
      void fetchView(id, controller.signal).then(view => {
        const applies = (previous: SessionSummary) => canApplyWebsiteSessionUpdate({ generation: current,
          currentGeneration: generation.current, aborted: controller.signal.aborted, expectedSessionId: id,
          actualSessionId: previous.id, previousRevision: previous.revision, incomingRevision: view.revision });
        setSelected(previous => previous && view.id === id && applies(previous) ? view : previous);
        setSessions(previous => previous.map(session => view.id === id && applies(session) ? view : session));
      }).catch(() => {}).finally(() => { inflight = false; });
    }, 1_500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [selected?.id, selected?.pending, busy, fetchView]);

  async function choose(id: string) {
    if (busy || loading) return;
    const current = ++generation.current;
    setLoading(true); setError(null); setReply(null); setPendingQuery(null);
    try { const view = await fetchView(id); if (current === generation.current) remember(view); }
    catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : messageFor()); }
    finally { if (current === generation.current) setLoading(false); }
  }
  async function create() {
    if (busy || loading) return;
    const current = ++generation.current;
    setLoading(true); setError(null); setReply(null); setPendingQuery(null);
    try {
      const response = await fetch("/api/website-agent/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json() as { session?: unknown; error?: { code?: string } };
      if (!response.ok || !validSession(body.session)) throw new Error(messageFor(body.error?.code));
      if (current === generation.current) remember(body.session);
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : messageFor()); }
    finally { if (current === generation.current) setLoading(false); }
  }
  async function close() {
    if (!selected || busy || loading || selected.pending) return;
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/website-agent/sessions/${encodeURIComponent(selected.id)}/close`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: selected.revision }),
      });
      const body = await response.json() as { session?: unknown; error?: { code?: string } };
      if (!response.ok || !validSession(body.session)) throw new Error(messageFor(body.error?.code));
      if (current === generation.current) remember(body.session);
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : messageFor()); }
    finally { if (current === generation.current) setLoading(false); }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || loading || !selected || selected.status !== "open" || selected.pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const controller = new AbortController(); active.current = controller;
    const current = ++generation.current;
    const id = selected.id;
    setBusy(true); setError(null); setReply(null); setPendingQuery(String(data.get("query") ?? ""));
    try {
      const response = await fetch("/api/website-agent/query", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ query: data.get("query"), session_id: id, expected_revision: selected.revision,
          operation_id: crypto.randomUUID(), data_consent: data.get("data_consent") === "on",
          collect: data.get("collect") === "on", read_sources: data.get("read_sources") === "on" }),
      });
      const body = await response.json() as WebsiteAgentReply & { error?: { code?: string } };
      if (current !== generation.current) return;
      if (!response.ok || typeof body.answer !== "string" || !validSession(body.session) || body.session.id !== id) {
        setError(messageFor(body.error?.code));
        const view = await fetchView(id, controller.signal).catch(() => null);
        if (view && current === generation.current) remember(view);
        return;
      }
      remember(body.session); setReply(body); form.reset();
    } catch {
      if (current === generation.current) {
        setError("连接已中断，暂时无法确认结果。请刷新会话；已保存的收藏不会撤销。");
        const view = await fetchView(id).catch(() => null);
        if (view && current === generation.current) remember(view);
      }
    } finally {
      if (current === generation.current) { active.current = null; setBusy(false); setPendingQuery(null); }
    }
  }
  function stopWaiting() {
    generation.current += 1; active.current?.abort(); active.current = null;
    setBusy(false); setPendingQuery(null);
    setError("已停止等待，并请求取消后续处理。已提交的收藏不会撤销，请刷新会话并查看收藏状态。");
  }
  const disabled = busy || loading || !selected || selected.status !== "open" || Boolean(selected.pending);
  return <section className="agent-console website-agent-console" aria-label="Attention 网页助手">
    <p className="website-agent-console__notice">会话按 Attention 账号保存，可稍后继续，不会导入或共享个人 Agent 会话。由 Pi 管理上下文；原始工具结果不保存，问题和最终回答（包括其中的引用）会保存。</p>
    <div className="website-agent-console__actions">
      <button className="button" onClick={create} disabled={busy || loading} type="button">新建会话</button>
      <label>会话 <select aria-label="选择会话" value={selected?.id ?? ""} disabled={busy || loading || sessions.length === 0} onChange={event => { void choose(event.target.value); }}>
        <option value="" disabled>选择或新建会话</option>
        {sessions.map(session => <option key={session.id} value={session.id}>{new Date(session.createdAt).toLocaleString("zh-CN")} · {session.status === "open" ? "进行中" : session.status === "closed" ? "已结束" : "已过期"}</option>)}
      </select></label>
      {selected ? <button className="button" disabled={busy || loading} type="button" onClick={() => { void choose(selected.id); }}>刷新会话</button> : null}
      {selected?.status === "open" ? <button className="button" disabled={busy || loading || Boolean(selected.pending)} onClick={close} type="button">结束会话</button> : null}
    </div>
    {loading ? <p role="status">正在读取会话…</p> : !selected ? <p>新建一个会话，开始使用网页助手。</p> : <p><small>会话连续 7 天未使用后过期。{selected.status !== "open" ? "这个会话不能继续提问，请新建会话。" : ""}</small></p>}
    {selected?.messages.length ? <div className="website-agent-console__history" aria-label="会话记录">{selected.messages.map((message, index) => <div className={`website-agent-console__message website-agent-console__message--${message.role}`} key={`${selected.id}:${index}`}>
      <small>{message.role === "user" ? "你" : "Attention"}</small><p>{message.text}</p>
    </div>)}</div> : null}
    {pendingQuery || selected?.pending ? <p role="status" className="website-agent-console__message">{pendingQuery ?? selected?.pending?.query}<br /><small>请求尚未确认完成，刷新会话可查看状态。重新连接不会自动重试收费调用。</small></p> : null}
    <form className="agent-composer" onSubmit={ask}>
      <label className="sr-only" htmlFor="website-agent-query">询问 Attention</label>
      <textarea id="website-agent-query" name="query" maxLength={4_000} required rows={4} placeholder="查找我的收藏，或粘贴需要私密保存的链接与分享文案。" disabled={disabled} />
      <label className="website-agent-console__option"><input type="checkbox" name="collect" disabled={disabled} />允许把这条消息中的链接私密收藏</label>
      <label className="website-agent-console__option"><input type="checkbox" name="read_sources" disabled={disabled} />允许临时读取我的收藏中的公开网页正文</label>
      <label className="website-agent-console__option"><input type="checkbox" name="data_consent" required disabled={disabled} />同意将本次问题、此会话的必要上下文、账户和收藏信息及获准读取的正文发送给 DeepSeek，以生成回答</label>
      <div className="website-agent-console__actions">
        <button className="button button--primary" disabled={disabled} type="submit">{busy ? "正在处理…" : "询问网页助手"}</button>
        {busy ? <button className="button" onClick={stopWaiting} type="button">停止等待</button> : null}
        <Link href="/account">查看我的收藏</Link>
      </div>
    </form>
    {error ? <p role="alert" className="field-error">{error}</p> : null}
    {reply ? <small>DeepSeek V4.1 Flash · Pi · 模型调用 {reply.usage.modelCalls} 次 · 工具调用 {reply.usage.toolCalls} 次。AI 回答请结合原文核对。</small> : null}
    <p>收藏成功不代表正文已读取，也不代表共享摘要已经完成。<Link href="/account">查看收藏状态</Link></p>
  </section>;
}
