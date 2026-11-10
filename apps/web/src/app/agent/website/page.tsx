import type { Metadata } from "next";
import Link from "next/link";

import { LoginLink } from "../../../components/login-link";
import { PageIntro } from "../../../components/page-intro";
import { WebsiteAgentConsole } from "../../../components/website-agent-console";
import { getPagePrincipal } from "../../../server/session";
import { websiteAgentAvailableFor } from "../../../server/website-agent-config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "网页助手", description: "通过 Attention 的统一工具查询和私密保存收藏。" };

export default async function WebsiteAgentPage() {
  const principal = await getPagePrincipal();
  const available = principal?.isMember && websiteAgentAvailableFor(principal.accountId);
  return <div className="page-shell page-shell--form">
    <PageIntro eyebrow="Agent" title="Attention 网页助手"
      description={<p>由 Pi 运行，使用 DeepSeek V4.1 Flash，与个人 Agent 共享 Attention 的收藏、检索和安全规则。</p>} />
    {!principal ? <p><LoginLink>登录</LoginLink>后查看网页助手是否已为你的账号开放。</p>
      : available ? <WebsiteAgentConsole />
      : <p>网页助手尚未为当前账号开启。你仍可<Link href="/agent">连接自己的 Agent</Link>使用 Attention。</p>}
  </div>;
}
