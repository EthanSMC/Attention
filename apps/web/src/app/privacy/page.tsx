import type { Metadata } from "next";

import { PageIntro } from "../../components/page-intro";

export const metadata: Metadata = { title: "隐私政策" };

export default function PrivacyPage() {
  return (
    <article className="page-shell policy-page">
      <PageIntro description={<p>了解账号、私人链接和第三方连接的数据边界。</p>} eyebrow="2026-08-04 版本" title="Attention 隐私政策" />
      <section>
        <h2>我们保存什么</h2>
        <p>账号会保存邮箱、可选的 Attention ID、展示名和安全凭据的不可逆摘要。网站 Session、OAuth token、API Key 与 Channel 身份分别保存和撤销。</p>
        <h2>私人收藏</h2>
        <p><strong>私人链接同步到云端意味着服务端可以看到并保存 URL。</strong>私人收藏不会进入公开流、公共检索、日报或其他账号的结果。</p>
        <h2>游客</h2>
        <p>游客没有 Attention 账号或私人云端空间。完成邮箱验证前，收藏入口不会接收或暂存链接。</p>
        <h2>第三方来源与 Channel</h2>
        <p>打开原文会前往第三方网站。微信等 Channel 只在用户明确确认后绑定到当前账号，不能静默换绑。</p>
      </section>
      <p className="policy-page__notice">这是当前产品测试版隐私说明，正式商业上线前需要补充运营主体、联系方式、保存期限和数据权利流程。</p>
    </article>
  );
}
