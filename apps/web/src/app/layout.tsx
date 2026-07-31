import type { Metadata } from "next";
import type { ReactNode } from "react";

import { MobileNavigation, SiteHeader } from "../components/site-navigation";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Attention · 人筛选，AI 整理",
    template: "%s · Attention",
  },
  description: "由人公开筛选、由 AI 自动整理的信息层。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <SiteHeader />
        <main id="main-content">{children}</main>
        <MobileNavigation />
      </body>
    </html>
  );
}
