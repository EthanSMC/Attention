"use client";

import { useState } from "react";
import type { FormEvent } from "react";

interface ApiErrorBody {
  error?: { code?: string; retry_after_seconds?: number };
}

interface ChallengeResponse {
  challenge_id: string;
  expires_at: string;
  retry_after_seconds: number;
}

interface LoginResponse {
  redirect_to: string;
}

const errorMessages: Record<string, string> = {
  account_unavailable: "这个账号暂时无法登录。",
  challenge_consumed: "这组验证码已经使用，请重新获取。",
  challenge_expired: "验证码已过期，请重新获取。",
  challenge_locked: "验证码错误次数过多，请重新获取。",
  consent_required: "首次注册需要同意用户协议和隐私政策。",
  email_delivery_unavailable: "验证码暂时无法发送，请稍后重试。",
  invalid_challenge: "登录请求已失效，请重新获取验证码。",
  invalid_code: "验证码不正确。",
  invalid_credentials: "邮箱或密码不正确。",
  invalid_email: "请输入有效的邮箱地址。",
  referral_registration_unavailable: "邀请仅适用于尚未注册的新邮箱，或该邀请已不可使用。",
  rate_limited: "请求过于频繁，请稍后再试。",
};

async function readApiError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  const code = body.error?.code ?? "unknown_error";
  if (code === "rate_limited" && body.error?.retry_after_seconds) {
    return `请求过于频繁，请在 ${body.error.retry_after_seconds} 秒后重试。`;
  }
  return errorMessages[code] ?? "登录没有完成，请重试。";
}

export function EmailLoginForm({
  consumerInviteToken,
  returnTo,
}: {
  consumerInviteToken?: string;
  returnTo: string;
}) {
  const [method, setMethod] = useState<"code" | "password">("code");
  const [stage, setStage] = useState<"email" | "verify">("email");
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function completeLogin(redirectTo: string) {
    window.location.assign(redirectTo);
  }

  async function startCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/email/start", {
        body: JSON.stringify({
          ...(consumerInviteToken
            ? { consumer_invite_token: consumerInviteToken }
            : {}),
          email,
          return_to: returnTo,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const result = (await response.json()) as ChallengeResponse;
      setChallenge(result);
      setStage("verify");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "验证码没有发送，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    const formData = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/email/verify", {
        body: JSON.stringify({
          accept_terms: formData.get("accept_terms") === "on",
          challenge_id: challenge.challenge_id,
          code: String(formData.get("code") ?? "").trim(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const result = (await response.json()) as LoginResponse;
      completeLogin(result.redirect_to);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "验证码没有通过，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function passwordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password", {
        body: JSON.stringify({
          email: String(formData.get("email") ?? "").trim(),
          password: String(formData.get("password") ?? ""),
          return_to: returnTo,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const result = (await response.json()) as LoginResponse;
      completeLogin(result.redirect_to);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "密码登录没有完成，请重试。");
    } finally {
      setBusy(false);
    }
  }

  if (method === "password") {
    return (
      <form className="auth-form" onSubmit={passwordLogin}>
        <label htmlFor="password-email">邮箱</label>
        <input
          autoComplete="email"
          id="password-email"
          name="email"
          placeholder="name@example.com"
          required
          type="email"
        />
        <label htmlFor="password-value">密码</label>
        <input
          autoComplete="current-password"
          id="password-value"
          minLength={10}
          name="password"
          required
          type="password"
        />
        {error ? <p aria-live="polite" className="field-error">{error}</p> : null}
        <button className="button button--primary" disabled={busy} type="submit">
          {busy ? "正在登录…" : "登录"}
        </button>
        <button
          className="text-button auth-form__secondary"
          onClick={() => {
            setError(null);
            setMethod("code");
          }}
          type="button"
        >
          使用邮箱验证码
        </button>
        <a className="auth-form__secondary" href="/login?return_to=%2Faccount%2Fsettings">
          忘记密码？
        </a>
      </form>
    );
  }

  if (stage === "verify" && challenge) {
    return (
      <form className="auth-form" onSubmit={verifyCode}>
        <div className="auth-form__sent">
          <span>验证码已发送至</span>
          <strong>{email}</strong>
        </div>
        <label htmlFor="email-code">六位验证码</label>
        <input
          autoComplete="one-time-code"
          autoFocus
          id="email-code"
          inputMode="numeric"
          maxLength={6}
          minLength={6}
          name="code"
          pattern="[0-9]{6}"
          placeholder="000000"
          required
        />
        <label className="auth-form__consent">
          <input name="accept_terms" type="checkbox" />
          <span>
            如果这是首次注册，请同意<a href="/terms" target="_blank">用户协议</a>和
            <a href="/privacy" target="_blank">隐私政策</a>
          </span>
        </label>
        {error ? <p aria-live="polite" className="field-error">{error}</p> : null}
        <button className="button button--primary" disabled={busy} type="submit">
          {busy ? "正在确认…" : "确认并继续"}
        </button>
        <button
          className="text-button auth-form__secondary"
          onClick={() => {
            setChallenge(null);
            setError(null);
            setStage("email");
          }}
          type="button"
        >
          更换邮箱
        </button>
      </form>
    );
  }

  return (
    <form className="auth-form" onSubmit={startCode}>
      <label htmlFor="email-value">邮箱</label>
      <input
        autoComplete="email"
        autoFocus
        id="email-value"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="name@example.com"
        required
        type="email"
        value={email}
      />
      <p className="auth-form__hint">新邮箱会自动创建 Free 账号，已有邮箱直接登录。</p>
      {error ? <p aria-live="polite" className="field-error">{error}</p> : null}
      <button className="button button--primary" disabled={busy} type="submit">
        {busy ? "正在发送…" : "获取验证码"}
      </button>
      <button
        className="text-button auth-form__secondary"
        onClick={() => {
          setError(null);
          setMethod("password");
        }}
        type="button"
      >
        使用密码登录
      </button>
    </form>
  );
}
