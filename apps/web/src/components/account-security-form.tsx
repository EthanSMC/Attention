"use client";

import { useState, type FormEvent } from "react";

export function AccountSecurityForm({
  email,
  hasPassword,
}: {
  email: string | null;
  hasPassword: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("password_confirmation") ?? "");
    if (password !== confirmation) {
      setPasswordMessage("两次输入的密码不一致。");
      return;
    }

    setBusy(true);
    setPasswordMessage(null);
    try {
      const response = await fetch("/api/auth/password/set", {
        body: JSON.stringify({ password }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      if (response.ok) {
        formElement.reset();
        setPasswordMessage("密码已设置。以后仍可继续使用验证码登录。");
      } else if (result.error?.code === "recent_authentication_required") {
        setPasswordMessage("设置密码前需要重新验证邮箱，请退出后用验证码登录再设置。");
      } else {
        setPasswordMessage("密码需要 10–128 位，且不能包含控制字符。");
      }
    } catch {
      setPasswordMessage("密码没有保存，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <div>
          <p className="settings-card__eyebrow">登录方式</p>
          <h2>{hasPassword ? "更换密码" : "添加密码"}</h2>
          <p>
            {email ? `登录邮箱：${email} · 可使用验证码登录。` : "未绑定邮箱，无法使用验证码登录。"}
          </p>
        </div>
        <form className="settings-form" onSubmit={savePassword}>
          <label htmlFor="new-password">新密码</label>
          <input
            autoComplete="new-password"
            id="new-password"
            minLength={10}
            name="password"
            required
            type="password"
          />
          <label htmlFor="password-confirmation">再次输入</label>
          <input
            autoComplete="new-password"
            id="password-confirmation"
            minLength={10}
            name="password_confirmation"
            required
            type="password"
          />
          {passwordMessage ? <p aria-live="polite">{passwordMessage}</p> : null}
          <button
            className="button button--secondary"
            disabled={busy}
            type="submit"
          >
            {busy ? "保存中" : hasPassword ? "更换密码" : "设置密码"}
          </button>
        </form>
      </section>

      <section className="settings-card settings-card--session">
        <div>
          <p className="settings-card__eyebrow">当前会话</p>
          <h2>退出账号</h2>
          <p>只退出这个浏览器，不会撤销 Agent、OAuth 或 API Key 连接。</p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button className="button button--secondary" type="submit">
            退出当前账号
          </button>
        </form>
      </section>
    </div>
  );
}
