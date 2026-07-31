import type { Metadata } from "next";

import { CollectForm } from "../../components/collect-form";
import { PageIntro } from "../../components/page-intro";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "收藏",
  description: "粘贴链接或完整分享文案，让 Attention 安全识别并保存。",
};

export default async function CollectPage() {
  const principal = await getPagePrincipal();

  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={
          <p>
            粘贴一段分享文案也可以。Attention 会找出真实内容地址，完成安全确认后先保存链接；
            标题和摘要会按当前可用能力显示，没有摘要也不影响收藏。
          </p>
        }
        eyebrow="收藏入口 / Web"
        title="把值得保留的链接交给 AI"
      />
      {principal?.isMember ? (
        <CollectForm
          allowPublic={principal.isFilter}
          initialVisibility={principal.isFilter ? "public" : "private"}
        />
      ) : (
        <section className="receipt receipt--neutral">
          <p className="receipt__eyebrow">邀请制试运行</p>
          <h2>请先打开你的 Attention 邀请链接</h2>
          <p>邀请链接会自动完成登录，然后把你带回这个 Web 收藏入口。</p>
        </section>
      )}
    </div>
  );
}
