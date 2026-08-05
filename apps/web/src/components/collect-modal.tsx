"use client";

import { useEffect, useRef } from "react";

import { CollectForm } from "./collect-form";

export function CollectModal({
  authenticated,
  onClose,
  allowPublic,
}: {
  authenticated: boolean;
  onClose: () => void;
  allowPublic: boolean;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
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
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousActiveElement?.focus();
    };
  }, [onClose]);

  return (
    <div
      aria-labelledby="collect-modal-title"
      aria-modal="true"
      className="collect-modal"
      ref={modalRef}
      role="dialog"
    >
      <button
        aria-label="关闭收藏窗口"
        className="collect-modal__backdrop"
        onClick={onClose}
        type="button"
      />
      <section className="collect-modal__sheet">
        <header className="collect-modal__heading">
          <div>
            <p className="eyebrow">收藏 / Web</p>
            <h2 id="collect-modal-title">收藏链接</h2>
          </div>
          <button
            aria-label="关闭"
            className="collect-modal__close"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </header>
        {authenticated ? (
          <CollectForm
            allowPublic={allowPublic}
            initialVisibility={allowPublic ? "public" : "private"}
          />
        ) : (
          <section className="receipt receipt--neutral collect-modal__login">
            <p className="receipt__eyebrow">需要 Attention 账号</p>
            <h3>登录后才能收藏</h3>
            <p>登录后，收藏链接会保存到你的个人收藏。</p>
            <a
              className="button button--primary"
              href="/login?return_to=%2Fcollect"
            >
              登录后收藏
            </a>
          </section>
        )}
      </section>
    </div>
  );
}
