"use client";

import { useState, type FormEvent } from "react";

export function CheckoutConfirmation({ returnTo }: { returnTo: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/membership/start", {
      body: JSON.stringify({ confirm_auto_renewal: true, return_to: returnTo }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as { redirect_to?: string };
    setBusy(false);
    if (response.ok && result.redirect_to) window.location.assign(result.redirect_to);
    else setError("订阅服务暂时无法继续；没有产生扣费或订阅。");
  }
  return (
    <form className="checkout-confirmation" onSubmit={confirm}>
      <label><input name="auto_renewal" required type="checkbox" /><span>我确认体验结束后将按上方金额和周期自动续费；可在首次扣费前取消。</span></label>
      {error ? <p aria-live="polite" className="field-error">{error}</p> : null}
      <button className="button button--primary" disabled={busy} type="submit">{busy ? "正在进入安全结账…" : "确认并绑定订阅"}</button>
    </form>
  );
}
