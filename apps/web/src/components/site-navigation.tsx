"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { BotIcon, LibraryIcon, PlusIcon } from "./icons";

const navigationItems = [
  { href: "/ai", label: "AI 公开流", shortLabel: "AI 公开流", icon: BotIcon },
  { href: "/collect", label: "收藏链接", shortLabel: "收藏", icon: PlusIcon },
  { href: "/mine", label: "我的收藏", shortLabel: "我的", icon: LibraryIcon },
] as const;

function SignalLogo() {
  return (
    <span aria-hidden="true" className="signal-logo">
      <span className="signal-logo__human" />
      <span className="signal-logo__ai" />
    </span>
  );
}

function NavigationLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();

  return navigationItems.map((item) => {
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    const Icon = item.icon;

    return (
      <Link
        aria-current={active ? "page" : undefined}
        className={mobile ? "mobile-nav__link" : "site-nav__link"}
        href={item.href}
        key={item.href}
      >
        {mobile ? <Icon /> : null}
        <span>{mobile ? item.shortLabel : item.label}</span>
      </Link>
    );
  });
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" href="/ai" aria-label="Attention 首页">
          <SignalLogo />
          <span>Attention</span>
        </Link>
        <nav aria-label="主导航" className="site-nav">
          <NavigationLinks />
        </nav>
      </div>
    </header>
  );
}

export function MobileNavigation() {
  return (
    <nav aria-label="移动端主导航" className="mobile-nav">
      <NavigationLinks mobile />
    </nav>
  );
}
