import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeReturnTo } from "@attention/auth";

import { CheckoutConfirmation } from "../../../components/checkout-confirmation";
import { PageIntro } from "../../../components/page-intro";
import { getWebDatabase } from "../../../server/db";
import { membershipOffer, subscriptionPreview } from "../../../server/membership";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "确认会员订阅" };

const formatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeZone: "Asia/Shanghai" });

export default async function MembershipCheckoutPage({ searchParams }: { searchParams: Promise<{ return_to?: string }> }) {
  const returnTo = safeReturnTo((await searchParams).return_to ?? "/ai");
  const principal = await getPagePrincipal();
  if (!principal) redirect(`/auth?return_to=${encodeURIComponent(`/membership/checkout?return_to=${encodeURIComponent(returnTo)}`)}`);
  if (principal.isMember) redirect(returnTo);
  const offer = membershipOffer();
  if (!offer.providerAvailable) redirect(`/membership?return_to=${encodeURIComponent(returnTo)}`);
  const preview = await subscriptionPreview(getWebDatabase(), principal.accountId);
  return (
    <div className="page-shell page-shell--form">
      <PageIntro description={<p>最后确认前不会创建订阅，也不会扣费。</p>} eyebrow="Member / 结账确认" title="确认首次扣费" />
      <section className="authorization-card checkout-card">
        <dl>
          <div><dt>当前</dt><dd>{preview.trialEligible ? "3 个月 Member 体验" : "立即开通 Member"}</dd></div>
          <div><dt>首次扣费日期</dt><dd>{formatter.format(preview.firstChargeAt)}</dd></div>
          <div><dt>首次扣费金额</dt><dd>{offer.firstChargeAmountLabel}</dd></div>
          <div><dt>续费周期</dt><dd>{offer.billingIntervalLabel}</dd></div>
          <div><dt>完成后返回</dt><dd>{returnTo}</dd></div>
        </dl>
        <CheckoutConfirmation returnTo={returnTo} />
      </section>
    </div>
  );
}
