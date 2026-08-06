"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";

import {
  BotIcon,
  CompassIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
} from "./icons";
import { CollectModal } from "./collect-modal";

const navigationItems = [
  { href: "/ai", label: "发现", icon: CompassIcon },
  { href: "/agent", label: "Agent", icon: BotIcon },
  { href: "/account", label: "我的", icon: UserIcon },
] as const;

function isSettingsPath(pathname: string): boolean {
  return (
    pathname.startsWith("/account/settings") ||
    pathname.startsWith("/account/security") ||
    pathname.startsWith("/account/digests") ||
    pathname.startsWith("/account/connections") ||
    pathname.startsWith("/account/court") ||
    pathname.startsWith("/membership")
  );
}

export interface NavigationIdentity {
  isFilter: boolean;
  isMember: boolean;
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
  authenticated,
  mobile = false,
}: {
  authenticated: boolean;
  mobile?: boolean;
}) {
  const pathname = usePathname();

  return navigationItems.map((item) => {
    const href =
      item.href === "/account" && !authenticated
        ? "/login?return_to=%2Faccount"
        : item.href;
    const active =
      pathname === item.href ||
      (item.href === "/account"
        ? pathname.startsWith("/account/") && (mobile || !isSettingsPath(pathname))
        : pathname.startsWith(`${item.href}/`));
    const Icon = item.icon;

    return (
      <Link
        aria-current={active ? "page" : undefined}
        className={mobile ? "mobile-nav__link" : "site-nav__link"}
        href={href}
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
  const pathname = usePathname();
  const [collectOpen, setCollectOpen] = useState(false);
  const settingsActive = isSettingsPath(pathname);
  const closeCollect = useCallback(() => setCollectOpen(false), []);

  return (
    <header
      className={`site-header${identity ? " site-header--authenticated" : ""}`}
    >
      <div className="site-header__inner">
        <Link className="brand" href="/ai" aria-label="Attention 首页">
          <SignalLogo />
          <span>Attention</span>
        </Link>
        <nav aria-label="主导航" className="site-nav">
          <NavigationLinks authenticated={identity !== null} />
        </nav>
        <div className="account-nav">
          <button
            aria-expanded={collectOpen}
            aria-haspopup="dialog"
            className="account-nav__collect"
            onClick={() => setCollectOpen(true)}
            type="button"
          >
            <PlusIcon />
            <span>收藏链接</span>
          </button>
          {identity ? (
            <Link
              aria-current={settingsActive ? "page" : undefined}
              className="site-nav__link site-nav__settings"
              href="/account/settings"
              title="设置"
            >
              <SettingsIcon />
              <span>设置</span>
            </Link>
          ) : null}
          {!identity ? (
            <Link className="account-nav__login" href="/login">
              登录
            </Link>
          ) : null}
        </div>
      </div>
      {collectOpen ? (
        <CollectModal
          allowPublic={identity?.isFilter ?? false}
          authenticated={identity !== null}
          onClose={closeCollect}
        />
      ) : null}
    </header>
  );
}

export function MobileNavigation({ identity }: { identity: NavigationIdentity | null }) {
  return (
    <nav aria-label="移动端主导航" className="mobile-nav">
      <NavigationLinks authenticated={identity !== null} mobile />
    </nav>
  );
}
