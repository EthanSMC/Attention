"use client";

import { useState, type FormEvent } from "react";

export function AccountSettingsForm({
  displayName,
  email,
  hasPassword,
  stableHandle,
}: {
  displayName: string;
  email: string | null;
  hasPassword: boolean;
  stableHandle: string;
}) {
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setProfileMessage(null);
    const response = await fetch("/api/account/profile", {
      body: JSON.stringify({ display_name: form.get("display_name") }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    setBusy(false);
    setProfileMessage(response.ok ? "网名已保存。" : "没有保存，请检查长度后重试。");
  }

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
    const response = await fetch("/api/auth/password/set", {
      body: JSON.stringify({ password }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    setBusy(false);
    if (response.ok) {
      formElement.reset();
      setPasswordMessage("密码已设置。以后仍可继续使用验证码登录。");
    } else if (result.error?.code === "recent_authentication_required") {
      setPasswordMessage("设置密码前需要重新验证邮箱，请退出后用验证码登录再设置。");
    } else {
      setPasswordMessage("密码需要 10–128 位，且不能包含控制字符。");
    }
  }

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <div>
          <p className="settings-card__eyebrow">公开身份</p>
          <h2>网名与 handle</h2>
          <p>网名可以修改；@{stableHandle} 是系统生成的稳定标识。</p>
        </div>
        <form className="settings-form" onSubmit={saveProfile}>
          <label htmlFor="display-name">网名</label>
          <input defaultValue={displayName} id="display-name" maxLength={50} name="display_name" required />
          {profileMessage ? <p aria-live="polite">{profileMessage}</p> : null}
          <button className="button button--secondary" disabled={busy} type="submit">保存网名</button>
        </form>
      </section>

      <section className="settings-card">
        <div>
          <p className="settings-card__eyebrow">账号安全</p>
          <h2>{hasPassword ? "更换密码" : "添加密码"}</h2>
          <p>{email ?? "当前账号没有邮箱"} · 验证码登录始终可用。</p>
        </div>
        <form className="settings-form" onSubmit={savePassword}>
          <label htmlFor="new-password">新密码</label>
          <input autoComplete="new-password" id="new-password" minLength={10} name="password" required type="password" />
          <label htmlFor="password-confirmation">再次输入</label>
          <input autoComplete="new-password" id="password-confirmation" minLength={10} name="password_confirmation" required type="password" />
          {passwordMessage ? <p aria-live="polite">{passwordMessage}</p> : null}
          <button className="button button--secondary" disabled={busy} type="submit">{hasPassword ? "更换密码" : "设置密码"}</button>
        </form>
      </section>
    </div>
  );
}
