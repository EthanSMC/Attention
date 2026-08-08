"use client";

import { type FormEvent, useEffect, useRef } from "react";

import { TransientFeedback, useTransientFeedback } from "./transient-feedback";

export function ApiKeyCreateModal({
  busy,
  error,
  name,
  onCancel,
  onCreate,
  onFinish,
  onNameChange,
  retryBlocked,
  secret,
  stage,
}: {
  busy: boolean;
  error: string | null;
  name: string;
  onCancel: () => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onFinish: () => void;
  onNameChange: (value: string) => void;
  retryBlocked: boolean;
  secret: string | null;
  stage: "naming" | "revealed";
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const revealWarningRef = useRef<HTMLParagraphElement>(null);
  const dismissibleRef = useRef(stage === "naming" && !busy);
  const onCancelRef = useRef(onCancel);
  const { feedback, showFeedback } = useTransientFeedback();

  useEffect(() => {
    dismissibleRef.current = stage === "naming" && !busy;
  }, [busy, stage]);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!dismissibleRef.current) return;
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter(
        (element) =>
          element.getClientRects().length > 0 &&
          !element.hasAttribute("data-modal-backdrop"),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousActiveElement?.focus();
    };
  }, []);

  useEffect(() => {
    if (stage === "naming") nameInputRef.current?.focus();
    else revealWarningRef.current?.focus();
  }, [stage]);

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      showFeedback("密钥已复制。请把它保存到你的 Agent 或密码管理器中。");
    } catch {
      showFeedback("复制失败，请手动选择并复制密钥。", "error");
    }
  }

  const canDismiss = stage === "naming" && !busy;
  const title = stage === "naming" ? "创建 API Key" : "保存这枚 API Key";

  return (
    <div
      aria-labelledby="api-key-modal-title"
      aria-modal="true"
      className="collect-modal api-key-modal"
      ref={modalRef}
      role="dialog"
    >
      <button
        aria-label="关闭 API Key 窗口"
        className="collect-modal__backdrop"
        data-modal-backdrop=""
        disabled={!canDismiss}
        onClick={onCancel}
        tabIndex={-1}
        type="button"
      />
      <section className="collect-modal__sheet api-key-modal__sheet">
        <header className="collect-modal__heading">
          <div>
            <p className="eyebrow">API Key / Agent</p>
            <h2 id="api-key-modal-title">{title}</h2>
          </div>
          {canDismiss ? (
            <button
              aria-label="关闭"
              className="collect-modal__close"
              onClick={onCancel}
              type="button"
            >
              ×
            </button>
          ) : null}
        </header>

        {stage === "naming" ? (
          <form className="api-key-modal__form" onSubmit={onCreate}>
            <label className="api-key-modal__field" htmlFor="api-key-name">
              <span>名称</span>
              <input
                autoComplete="off"
                disabled={busy}
                id="api-key-name"
                maxLength={100}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="例如：Claude on MacBook"
                ref={nameInputRef}
                required
                value={name}
              />
            </label>
            <p className="api-key-modal__hint">用设备或客户端命名，方便以后识别和撤销。</p>
            {error ? <p className="api-key-modal__error" role="alert">{error}</p> : null}
            <div className="api-key-modal__actions">
              <button
                className="button button--secondary"
                disabled={busy}
                onClick={onCancel}
                type="button"
              >
                {retryBlocked ? "关闭并刷新" : "取消"}
              </button>
              <button
                className="button button--primary"
                disabled={busy || retryBlocked || name.trim().length === 0}
                type="submit"
              >
                {busy ? "正在创建…" : retryBlocked ? "请先刷新" : "创建"}
              </button>
            </div>
          </form>
        ) : (
          <div className="api-key-modal__reveal">
            <p
              aria-live="assertive"
              className="api-key-modal__warning"
              id="api-key-modal-warning"
              ref={revealWarningRef}
              role="status"
              tabIndex={-1}
            >
              完整密钥只显示这一次。关闭窗口后，Attention 只保留哈希与前缀，无法替你找回。
            </p>
            <div className="api-key-modal__secret">
              <span>完整密钥</span>
              <code>{secret}</code>
            </div>
            <div className="api-key-modal__actions">
              <button
                className="button button--primary"
                onClick={copySecret}
                ref={copyButtonRef}
                type="button"
              >
                复制密钥
              </button>
              <button className="button button--secondary" onClick={onFinish} type="button">
                已保存，关闭
              </button>
            </div>
          </div>
        )}
      </section>
      <TransientFeedback feedback={feedback} />
    </div>
  );
}
