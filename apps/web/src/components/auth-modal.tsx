"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export function AuthModal({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <div aria-label="登录 Attention" aria-modal="true" className="auth-modal" role="dialog">
      <button aria-label="关闭登录" className="auth-modal__backdrop" onClick={() => router.back()} type="button" />
      <section className="auth-modal__sheet">
        <button aria-label="关闭" className="auth-modal__close" onClick={() => router.back()} type="button">×</button>
        {children}
      </section>
    </div>
  );
}
