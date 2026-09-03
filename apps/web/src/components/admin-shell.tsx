import Link from "next/link";
import type { ReactNode } from "react";

import type { AdminUsersTab } from "../lib/admin-users-navigation";
import { LibraryIcon, UserIcon } from "./icons";

interface AdminShellIdentity {
  attentionId: string | null;
  displayName: string;
  primaryEmail: string | null;
}

export function AdminShell({
  active,
  auditsHref,
  children,
  identity,
  usersHref,
}: {
  active: AdminUsersTab;
  auditsHref: string;
  children: ReactNode;
  identity: AdminShellIdentity;
  usersHref: string;
}) {
  const avatarFallback =
    Array.from(identity.displayName.trim())[0]?.toLocaleUpperCase("zh-CN") ??
    "A";

  return (
    <div className="admin-shell">
      <aside className="admin-shell__sidebar">
        <section className="admin-identity" aria-label="当前管理员">
          <span aria-hidden="true" className="admin-identity__avatar">
            {avatarFallback}
          </span>
          <div className="admin-identity__copy">
            <p className="admin-identity__role">Attention Admin</p>
            <strong>{identity.displayName}</strong>
            <span>{identity.primaryEmail ?? "未绑定邮箱"}</span>
            <span>
              {identity.attentionId
                ? `@${identity.attentionId}`
                : "未设置 Attention ID"}
            </span>
          </div>
        </section>

        <nav className="admin-navigation">
          <p>管理</p>
          <Link
            href={usersHref}
            aria-current={active === "users" ? "page" : undefined}
          >
            <UserIcon />
            <span>用户权限</span>
          </Link>
          <Link
            href={auditsHref}
            aria-current={active === "audits" ? "page" : undefined}
          >
            <LibraryIcon />
            <span>审计记录</span>
          </Link>
        </nav>
      </aside>

      <main className="admin-shell__content">{children}</main>
    </div>
  );
}
