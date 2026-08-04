"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { BotIcon, CompassIcon, LibraryIcon, PlusIcon, UserIcon } from "./icons";

const navigationItems = [
  { href: "/ai", label: "发现", icon: CompassIcon },
  { href: "/mine", label: "收藏", icon: LibraryIcon },
  { href: "/agent", label: "Agent", icon: BotIcon },
  { href: "/account", label: "我的", icon: UserIcon },
] as const;

export interface NavigationIdentity {
  isMember: boolean;
  stableHandle: string;
}

function SignalLogo() {
  return (
    <span aria-hidden="true" className="signal-logo">
      <span className="signal-logo__human" />
      <span className="signal-logo__ai" />
    </span>
  );
}

function NavigationLinks({
  mobile = false,
}: {
  mobile?: boolean;
}) {
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
        title={item.label}
      >
        <Icon />
        <span>{item.label}</span>
      </Link>
    );
  });
}

export function SiteHeader({ identity }: { identity: NavigationIdentity | null }) {
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
        <div className="account-nav">
          <Link className="account-nav__collect" href="/collect">
            <PlusIcon />
            <span>收藏链接</span>
          </Link>
          {identity ? (
            <>
              <span className="account-nav__identity" title={`当前登录为 @${identity.stableHandle}`}>
                <UserIcon />
                <span className="account-nav__handle">@{identity.stableHandle}</span>
              </span>
              <form action="/api/auth/logout" method="post">
                <button className="account-nav__logout" type="submit">退出</button>
              </form>
            </>
          ) : (
            <Link className="account-nav__login" href="/login">
              登录
            </Link>
          )}
        </div>
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
