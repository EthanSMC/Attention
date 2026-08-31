import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound, redirect } from "next/navigation";
import { z } from "zod";

import { AdminUserEntitlementControl } from "../../../components/admin-user-entitlement-control";
import { AdminAccessError, requireAdminPrincipal } from "../../../server/admin-access";
import {
  AdminUserEntitlementError,
  listAdminEntitlementAudits,
  listAdminUsers,
  parseAdminUserListInput,
  type AdminEntitlementTier,
} from "../../../server/admin-user-entitlements";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "用户权限管理",
};

type SearchValue = string | string[] | undefined;

interface AdminUsersSearchParams {
  audit_user?: SearchValue;
  page?: SearchValue;
  q?: SearchValue;
  tier?: SearchValue;
}

function single(value: SearchValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tierLabel(tier: AdminEntitlementTier): string {
  if (tier === "filter") return "Filter";
  if (tier === "member") return "Member";
  return "Free";
}

function actionLabel(action: "revoke_filter" | "set_filter" | "set_member"): string {
  if (action === "set_filter") return "设为 Filter";
  if (action === "set_member") return "设为 Member";
  return "撤销 Filter";
}

function usersHref(
  input: { page: number; query?: string; tier?: AdminEntitlementTier },
  extra: { auditUser?: string } = {},
): string {
  const params = new URLSearchParams();
  if (input.query) params.set("q", input.query);
  if (input.tier) params.set("tier", input.tier);
  if (input.page > 1) params.set("page", String(input.page));
  if (extra.auditUser) params.set("audit_user", extra.auditUser);
  const query = params.toString();
  return query ? `/admin/users?${query}` : "/admin/users";
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<AdminUsersSearchParams>;
}) {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Fadmin%2Fusers");
  try {
    requireAdminPrincipal(principal);
  } catch (error) {
    if (error instanceof AdminAccessError) forbidden();
    throw error;
  }

  const params = await searchParams;
  let input;
  try {
    input = parseAdminUserListInput({
      page: single(params.page),
      pageSize: 25,
      query: single(params.q),
      tier: single(params.tier),
    });
  } catch {
    redirect("/admin/users");
  }

  const selectedRaw = single(params.audit_user);
  const selectedResult = selectedRaw
    ? z.string().uuid().safeParse(selectedRaw)
    : null;
  if (selectedResult && !selectedResult.success) redirect(usersHref(input));
  const selectedAccountId = selectedResult?.success
    ? selectedResult.data
    : undefined;
  const db = getWebDatabase();
  const users = await listAdminUsers(db, principal, input);
  let audits = null;
  if (selectedAccountId) {
    try {
      audits = await listAdminEntitlementAudits(
        db,
        principal,
        selectedAccountId,
        50,
      );
    } catch (error) {
      if (
        error instanceof AdminUserEntitlementError &&
        error.code === "target_account_not_found"
      ) {
        notFound();
      }
      throw error;
    }
  }
  const selectedUser = users.items.find(
    (item) => item.accountId === selectedAccountId,
  );

  return (
    <div className="admin-users-shell">
      <header className="admin-users-header">
        <div>
          <p className="eyebrow">Attention Admin</p>
          <h1>用户权限管理</h1>
          <p>仅限白名单管理员。所有变更立即生效并记录审计。</p>
        </div>
        <span className="admin-users-header__identity">
          {principal.displayName}
        </span>
      </header>

      <form action="/admin/users" className="admin-user-filters" method="get">
        <label>
          <span>邮箱、昵称或 Attention ID</span>
          <input
            defaultValue={input.query ?? ""}
            maxLength={100}
            name="q"
            placeholder="输入关键词"
            type="search"
          />
        </label>
        <label>
          <span>当前权益</span>
          <select defaultValue={input.tier ?? ""} name="tier">
            <option value="">全部</option>
            <option value="free">Free</option>
            <option value="member">Member</option>
            <option value="filter">Filter</option>
          </select>
        </label>
        <button className="button button--primary" type="submit">
          查询
        </button>
      </form>

      <section className="admin-users-list" aria-labelledby="admin-users-count">
        <div className="admin-users-list__summary">
          <h2 id="admin-users-count">用户（{users.total}）</h2>
          <p>
            第 {users.page} 页 / {Math.max(users.totalPages, 1)} 页
          </p>
        </div>
        <div className="admin-users-table-wrap">
          <table className="admin-users-table">
            <thead>
              <tr>
                <th>账号</th>
                <th>注册时间</th>
                <th>权益</th>
                <th>单用户操作</th>
              </tr>
            </thead>
            <tbody>
              {users.items.map((user) => (
                <tr key={user.accountId}>
                  <td>
                    <strong>{user.displayName}</strong>
                    <span>{user.primaryEmail ?? "未绑定邮箱"}</span>
                    <span>
                      {user.attentionId ? `@${user.attentionId}` : "未设置 Attention ID"}
                    </span>
                    <span>账号状态：{user.status}</span>
                  </td>
                  <td>
                    <time dateTime={user.createdAt.toISOString()}>
                      {user.createdAt.toLocaleString("zh-CN", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </td>
                  <td>
                    <span className={`admin-tier admin-tier--${user.tier}`}>
                      {tierLabel(user.tier)}
                    </span>
                    <Link
                      className="admin-audit-link"
                      href={usersHref(input, { auditUser: user.accountId })}
                    >
                      查看审计
                    </Link>
                  </td>
                  <td>
                    <AdminUserEntitlementControl
                      currentTier={user.tier}
                      targetAccountId={user.accountId}
                      targetLabel={user.primaryEmail ?? user.displayName}
                    />
                  </td>
                </tr>
              ))}
              {users.items.length === 0 ? (
                <tr>
                  <td className="admin-users-table__empty" colSpan={4}>
                    没有符合条件的用户。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <nav aria-label="用户分页" className="admin-pagination">
          {users.page > 1 ? (
            <Link href={usersHref({ ...input, page: users.page - 1 })}>上一页</Link>
          ) : (
            <span>上一页</span>
          )}
          {users.page < users.totalPages ? (
            <Link href={usersHref({ ...input, page: users.page + 1 })}>下一页</Link>
          ) : (
            <span>下一页</span>
          )}
        </nav>
      </section>

      {selectedAccountId && audits ? (
        <section className="admin-audit-panel" aria-labelledby="admin-audit-title">
          <div className="admin-audit-panel__header">
            <div>
              <p className="eyebrow">Audit</p>
              <h2 id="admin-audit-title">
                {selectedUser?.displayName ?? "所选用户"}的权益审计
              </h2>
            </div>
            <Link href={usersHref(input)}>关闭</Link>
          </div>
          <ol>
            {audits.map((audit) => (
              <li key={audit.id}>
                <div className="admin-audit-panel__event">
                  <strong>{actionLabel(audit.action)}</strong>
                  <time dateTime={audit.occurredAt.toISOString()}>
                    {audit.occurredAt.toLocaleString("zh-CN")}
                  </time>
                </div>
                <p>
                  {tierLabel(audit.previousState.tier)} → {tierLabel(audit.nextState.tier)}
                </p>
                <p>原因：{audit.reason}</p>
                <small>
                  操作者：{audit.actor.displayName}（{audit.actor.primaryEmail ?? audit.actor.accountId}）
                  · 来源：{audit.source} · 请求：{audit.requestId}
                </small>
              </li>
            ))}
            {audits.length === 0 ? <li>暂无权益变更记录。</li> : null}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
