"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function ContentReportControl({
  publicContentId,
}: {
  publicContentId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/moderation/reports", {
      body: JSON.stringify({
        details: form.get("details") || null,
        public_content_id: publicContentId,
        reason_code: form.get("reason_code"),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as {
      case_opened?: boolean;
      duplicate?: boolean;
      error?: { code?: string };
    };
    setBusy(false);
    if (response.ok) {
      setMessage(result.duplicate ? "你已经举报过这条内容。" : "举报已记录。感谢帮助社区复核。");
      if (result.case_opened) router.refresh();
      return;
    }
    setMessage(
      result.error?.code === "authentication_required"
        ? "请先登录后再举报。"
        : result.error?.code === "content_not_reportable"
          ? "内容已不可公开访问，无需重复举报。"
          : "举报未提交，请稍后重试。",
    );
  }

  return (
    <details className="content-report-control">
      <summary>举报</summary>
      <form onSubmit={submit}>
        <label>
          原因
          <select defaultValue="misleading" name="reason_code">
            <option value="misleading">误导或事实问题</option>
            <option value="spam">垃圾或推广</option>
            <option value="unsafe">可能不安全</option>
            <option value="rights">权利或署名问题</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label>
          补充说明（可选）
          <textarea maxLength={2000} name="details" rows={3} />
        </label>
        {message ? <p aria-live="polite">{message}</p> : null}
        <button className="button button--secondary" disabled={busy} type="submit">
          {busy ? "提交中…" : "提交举报"}
        </button>
      </form>
    </details>
  );
}
