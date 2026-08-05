import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";

import { EmailLoginForm } from "../../../components/email-login-form";
import { PageIntro } from "../../../components/page-intro";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  description: "使用新用户邀请为新邮箱注册 Attention。",
  title: "新用户邀请",
};

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u);

export default async function ConsumerJoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const principal = await getPagePrincipal();
  if (principal) redirect("/account/rewards?invite=existing_account");
  const parsed = tokenSchema.safeParse((await params).token);
  const token = parsed.success ? parsed.data : "_".repeat(43);
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={
          <p>
            邀请只对尚未创建 Attention 账号的新邮箱有效。邮箱验证成功后，
            双方的三个月 Member 奖励会在同一事务中发放。
          </p>
        }
        eyebrow="新用户邀请"
        title="创建你的 Attention 账号"
      />
      <section className="login-panel">
        <p className="login-panel__step">新邮箱注册</p>
        <h2>验证邮箱后领取邀请权益</h2>
        <p>页面不会显示邀请人的邮箱、姓名或其他私人信息。</p>
        <EmailLoginForm
          consumerInviteToken={token}
          returnTo="/account/rewards?invite=accepted"
        />
      </section>
    </div>
  );
}
