import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeReturnTo } from "@attention/auth";

import { EmailLoginForm } from "../../components/email-login-form";
import { PageIntro } from "../../components/page-intro";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "授权登录" };

export default async function ExternalAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const returnTo = safeReturnTo((await searchParams).return_to);
  const principal = await getPagePrincipal();
  if (principal) redirect(returnTo);
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>用于 CLI、Agent、Hosted MCP 或 Channel 绑定。完成登录后会回到原授权操作。</p>}
        eyebrow="Attention 安全授权"
        title="先确认你的账号"
      />
      <section className="login-panel">
        <p className="login-panel__step">统一邮箱入口</p>
        <h2>登录 Attention</h2>
        <p>登录只证明身份，不会自动开通会员或批准第三方权限。</p>
        <EmailLoginForm returnTo={returnTo} />
      </section>
    </div>
  );
}
