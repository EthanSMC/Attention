import type { Metadata } from "next";

import { MembershipAction } from "../../components/membership-action";
import { PageIntro } from "../../components/page-intro";
import { membershipOffer } from "../../server/membership";
import { publicFeedPreviewLimit } from "../../server/public-access";
import { getPagePrincipal } from "../../server/session";
import { safeReturnTo } from "@attention/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "会员" };

export default async function MembershipPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const principal = await getPagePrincipal();
  const offer = membershipOffer();
  const previewLimit = publicFeedPreviewLimit();
  const returnTo = safeReturnTo((await searchParams).return_to ?? "/ai");
  return (
    <div className="page-shell membership-page">
      <PageIntro
        description={<p>Free 建立自己的收藏库；Member 解锁完整的高质量内容网络与托管能力。</p>}
        eyebrow="Attention 会员"
        title="把注意力留给值得看的内容"
      />
      <div className="plan-grid">
        <section className="plan-card">
          <p className="plan-card__name">Free</p>
          <h2>¥0</h2>
          <p>不限量收藏和云端同步，基础个人收藏 MCP。</p>
          <ul><li>自己的私人收藏库</li><li>前 {previewLimit} 张公开内容</li><li>CLI / Skill 本地处理</li></ul>
        </section>
        <section className="plan-card plan-card--featured">
          <p className="plan-card__name">Member</p>
          <h2>{offer.priceLabel}</h2>
          <p>首次主动绑定订阅可体验 {offer.trialMonths} 个月；{offer.billingIntervalLabel}。</p>
          <ul><li>完整公开发现与日报</li><li>托管 AI 检索、筛选和订阅</li><li>高级 Hosted MCP 与 Hosted Channel</li></ul>
          <p className="plan-card__charge">首次扣费：体验结束后 {offer.firstChargeAmountLabel}</p>
          <MembershipAction
            isAuthenticated={principal !== null}
            isMember={principal?.isMember ?? false}
            providerAvailable={offer.providerAvailable}
            returnTo={returnTo}
          />
        </section>
      </div>
      <p className="membership-disclosure">确认开通前会再次显示准确金额、首次扣费日期和自动续费规则；未确认前不会创建订阅。</p>
    </div>
  );
}
