import type { Metadata } from "next";
import Link from "next/link";

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
      {principal ? (
        <CollectForm
          allowPublic={principal.isFilter}
          initialVisibility={principal.isFilter ? "public" : "private"}
        />
      ) : (
        <section className="receipt receipt--neutral">
          <p className="receipt__eyebrow">需要 Attention 账号</p>
          <h2>登录后才能收藏</h2>
          <p>登录前不会接收或暂存你要收藏的链接。</p>
          <Link className="button button--primary" href="/login?return_to=%2Fcollect">登录后收藏</Link>
        </section>
      )}
    </div>
  );
}
