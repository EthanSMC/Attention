import Link from "next/link";
import type { ReactNode } from "react";

import {
  ArrowUpRightIcon,
  BotIcon,
  LibraryIcon,
  LinkIcon,
  LockIcon,
  UserIcon,
} from "./icons";

type SettingsSection = "account" | "connections" | "digests" | "security";

const coreItems = [
  {
    href: "/account/settings",
    icon: UserIcon,
    id: "account" as const,
    label: "账号资料",
  },
  {
    href: "/account/security",
    icon: LockIcon,
    id: "security" as const,
    label: "安全",
  },
  {
    href: "/account/digests",
    icon: BotIcon,
    id: "digests" as const,
    label: "日报",
  },
  {
    href: "/account/connections",
    icon: LinkIcon,
    id: "connections" as const,
    label: "连接与授权",
  },
];

export function AccountSettingsShell({
  active,
  children,
  description,
  isFilter,
  title,
}: {
  active: SettingsSection;
  children: ReactNode;
  description: string;
  isFilter: boolean;
  title: string;
}) {
  return (
    <div className="page-shell page-shell--settings">
      <div className="settings-shell">
        <nav aria-label="设置分区" className="settings-shell__navigation">
          <div className="settings-nav__group">
            <p>账户</p>
            {coreItems.map(({ href, icon: Icon, id, label }) => (
              <Link
                aria-current={active === id ? "page" : undefined}
                href={href}
                key={id}
              >
                <Icon />
                <span>{label}</span>
              </Link>
            ))}
          </div>

          {isFilter ? (
            <div className="settings-nav__group">
              <p>Filter 权益</p>
              <Link
                href="/account/court"
                rel="noopener noreferrer"
                target="_blank"
              >
                <LibraryIcon />
                <span>小法庭</span>
                <ArrowUpRightIcon className="settings-nav__external-icon" />
              </Link>
            </div>
          ) : null}
        </nav>

        <section
          aria-labelledby="settings-page-title"
          className="settings-shell__content"
        >
          <header className="settings-shell__heading">
            <h1 id="settings-page-title">{title}</h1>
            <p>{description}</p>
          </header>
          {children}
        </section>
      </div>
    </div>
  );
}
