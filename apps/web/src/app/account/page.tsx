import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageIntro } from "../../components/page-intro";
import { loadAccountOverview } from "../../server/account";
import { getWebDatabase } from "../../server/db";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的",
  description: "管理 Attention 账号、会员与 Agent 连接。",
};

export default async function AccountPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Faccount");
  const account = await loadAccountOverview(getWebDatabase(), principal.accountId);
  if (!account) redirect("/login?return_to=%2Faccount");

  return (
    <div className="page-shell page-shell--mine">
      <PageIntro
        description={<p>@{account.stableHandle} · {account.email}</p>}
        eyebrow="我的"
        title={account.displayName}
      />
      <section className="account-overview-grid">
        <Link className="account-overview-card" href="/membership">
          <span>会员</span>
          <strong>{principal.isMember ? "Member 已解锁" : "Free"}</strong>
          <p>{principal.isMember ? "完整发现、日报与高级 Agent 能力可用。" : "自己的收藏与基础云同步不限量。"}</p>
        </Link>
        <Link className="account-overview-card" href="/account/connections">
          <span>连接与授权</span>
          <strong>Agent、MCP 与微信</strong>
          <p>管理独立凭据；撤销某一种不会退出网站或解除其他连接。</p>
        </Link>
        <Link className="account-overview-card" href="/account/digests">
          <span>Domain 订阅</span>
          <strong>每日 Email</strong>
          <p>选择 AI Domain、账号时区与发送窗口；无新增内容时不会发送。</p>
        </Link>
        <Link className="account-overview-card" href="/account/rewards">
          <span>邀请与积分</span>
          <strong>季卡、年卡与续费奖励</strong>
          <p>创建 Consumer 邀请、兑换 Filter 年卡，并查看按币种记录的续费积分。</p>
        </Link>
        <Link className="account-overview-card" href="/account/settings">
          <span>账号安全</span>
          <strong>网名与登录方式</strong>
          <p>修改显示网名、添加密码，验证码登录始终保留。</p>
        </Link>
        {principal.isFilter ? (
          <Link className="account-overview-card" href="/account/court">
            <span>Filter 小法庭</span>
            <strong>社区复核</strong>
            <p>查看达到举报阈值的内容，并在 24 小时窗口内投出不可更改的一票。</p>
          </Link>
        ) : null}
      </section>
    </div>
  );
}
