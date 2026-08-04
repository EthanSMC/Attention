"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ModerationCourtItem {
  author: string | null;
  communityStatus: "clear" | "hidden" | "pending_review";
  eligibleFilterCount: number;
  hiddenVotes: number;
  id: string;
  myVote: "hidden" | "public" | null;
  openedAt: string;
  outboundHref: string | null;
  publicVotes: number;
  source: string;
  status: "open" | "requires_admin";
  title: string | null;
  votingEndsAt: string;
}

export function ModerationCourt({ cases }: { cases: ModerationCourtItem[] }) {
  const router = useRouter();
  const [busyCaseId, setBusyCaseId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function vote(caseId: string, decision: "hidden" | "public") {
    setBusyCaseId(caseId);
    setMessage(null);
    const response = await fetch(`/api/moderation/cases/${caseId}/votes`, {
      body: JSON.stringify({ decision }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    setBusyCaseId(null);
    if (response.ok) {
      setMessage("投票已记录，投出后不可更改。");
      router.refresh();
      return;
    }
    setMessage(
      result.error?.code === "vote_already_cast"
        ? "你已经投票，不能改票。"
        : result.error?.code === "voting_closed"
          ? "投票窗口已经结束。"
          : "投票失败，请刷新后重试。",
    );
  }

  if (cases.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state__eyebrow">当前无案件</p>
        <h2>小法庭是空的</h2>
        <p>达到举报阈值的内容会在这里等待所有有效 Filter 复核。</p>
      </div>
    );
  }

  return (
    <div className="moderation-court-list">
      {message ? <p aria-live="polite">{message}</p> : null}
      {cases.map((item) => (
        <article className="moderation-court-card" key={item.id}>
          <div>
            <p className="settings-card__eyebrow">
              {item.status === "requires_admin" ? "等待管理员" : "投票中"}
            </p>
            <h2>{item.title ?? "未命名内容"}</h2>
            <p>作者：{item.author?.trim() || "未提供"} · 来源：{item.source}</p>
            <p>
              截止：{new Date(item.votingEndsAt).toLocaleString("zh-CN")} · 当前有效 Filter {item.eligibleFilterCount} 人
            </p>
            {item.outboundHref ? (
              <a href={item.outboundHref} rel="noopener noreferrer" target="_blank">查看原文</a>
            ) : (
              <span>原文因安全或下架状态不可访问</span>
            )}
          </div>
          <div className="moderation-court-card__votes">
            <p>公开 {item.publicVotes} 票 · 隐藏 {item.hiddenVotes} 票</p>
            {item.status === "requires_admin" ? (
              <p>未达到有效裁决条件，内容继续隐藏并等待管理员处理。</p>
            ) : item.myVote ? (
              <p>你已投：{item.myVote === "public" ? "公开" : "隐藏"}。投票不可更改。</p>
            ) : (
              <div>
                <button
                  className="button button--secondary"
                  disabled={busyCaseId === item.id}
                  onClick={() => vote(item.id, "public")}
                  type="button"
                >
                  应公开
                </button>
                <button
                  className="button button--secondary"
                  disabled={busyCaseId === item.id}
                  onClick={() => vote(item.id, "hidden")}
                  type="button"
                >
                  应隐藏
                </button>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
