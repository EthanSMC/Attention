"use client";

import { useState } from "react";
import type { FormEvent } from "react";

export function LoginLinkForm() {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rawValue = String(data.get("invite_link") ?? "").trim();

    try {
      const url = new URL(rawValue, window.location.origin);
      const isAttentionLink =
        url.origin === window.location.origin &&
        /^\/invite\/[^/]+$/u.test(url.pathname);
      if (!isAttentionLink) throw new Error("invalid_link");
      window.location.assign(`${url.pathname}${url.search}`);
    } catch {
      setError("这不是有效的 Attention 专属登录链接，请完整复制后重试。");
    }
  }

  return (
    <form className="login-link-form" onSubmit={submit}>
      <label htmlFor="invite-link">专属登录链接</label>
      <div className="login-link-form__row">
        <input
          autoComplete="off"
          id="invite-link"
          name="invite_link"
          placeholder="http://…/invite/…"
          required
          type="url"
        />
        <button className="button button--primary" type="submit">
          继续登录
        </button>
      </div>
      {error ? <p aria-live="polite" className="field-error">{error}</p> : null}
    </form>
  );
}
