import type { Metadata } from "next";

import { PageIntro } from "../../components/page-intro";

export const metadata: Metadata = { title: "用户协议" };

export default function TermsPage() {
  return (
    <article className="page-shell policy-page">
      <PageIntro description={<p>使用收藏、公开发现、会员与 Agent 服务时适用。</p>} eyebrow="2026-08-04 版本" title="Attention 用户协议" />
      <section>
        <h2>服务范围</h2>
        <p>Attention 提供链接收藏、云端同步、公开发现、检索和 Agent 连接能力。原文始终由第三方来源提供，Attention 不保证外部链接永久有效。</p>
        <h2>公开与私密</h2>
        <p>普通账号的收藏默认私密；具备 Filter 资格的用户可将单条收藏公开。公开收藏是对链接的推荐，不代表 Attention 获得原文著作权。</p>
        <h2>合理使用</h2>
        <p>用户不得利用服务传播违法内容、绕过访问控制、批量探测私人数据或冒用他人身份。被举报的公开链接可以在审核期间隐藏。</p>
        <h2>会员</h2>
        <p>订阅前会单独展示价格、首次扣费时间和续费规则；页面未明确确认前不会创建自动续费订阅。</p>
      </section>
      <p className="policy-page__notice">这是当前产品测试版协议文本，正式商业上线前需要结合运营主体、支付和部署地区完成法律审阅。</p>
    </article>
  );
}
