import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeReturnTo } from "@attention/auth";

import { EmailLoginForm } from "../../components/email-login-form";
import { PageIntro } from "../../components/page-intro";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "登录",
  description: "使用邮箱验证码注册或登录 Attention。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  const principal = await getPagePrincipal();
  if (principal) redirect(returnTo);

  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={
          <p>
            一个入口完成注册或登录。验证码通过后，这台设备会保持登录；
            新账号从 Free 开始。
          </p>
        }
        eyebrow="Attention 账号"
        title="登录 Attention"
      />
      <section className="login-panel">
        <p className="login-panel__step">邮箱验证码</p>
        <h2>继续你的收藏和发现</h2>
        <p>无需先设置密码、网名或绑定微信。</p>
        <EmailLoginForm returnTo={returnTo} />
        <p className="login-panel__note">
          游客不会创建匿名账号，也不会在服务端暂存收藏链接。
        </p>
      </section>
    </div>
  );
}
