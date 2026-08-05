import type { Metadata } from "next";
import Link from "next/link";

import { AgentConsole } from "../../components/agent-console";
import { PageIntro } from "../../components/page-intro";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agent" };

export default async function AgentPage() {
  const principal = await getPagePrincipal();
  return (
    <div className="page-shell page-shell--form page-shell--primary">
      <PageIntro
        description={<p>用自然语言找回自己的收藏，并从引用直接回到原文。</p>}
        eyebrow="Attention Agent"
        title="问你的收藏"
      />
      {!principal ? (
        <section className="receipt receipt--neutral"><h2>登录后使用 Agent</h2><p>游客没有私人收藏空间。</p><Link className="button button--primary" href="/login?return_to=%2Fagent">登录</Link></section>
      ) : !principal.isMember ? (
        <section className="receipt receipt--neutral"><h2>Member 能力</h2><p>AI 检索会访问你的私人收藏，但结果只返回给当前账号。</p><Link className="button button--primary" href="/membership?return_to=%2Fagent">查看会员方案</Link></section>
      ) : (
        <AgentConsole />
      )}
    </div>
  );
}
