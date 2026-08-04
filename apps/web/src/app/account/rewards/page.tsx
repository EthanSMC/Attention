import { loadGrowthDashboard } from "@attention/auth";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  GrowthRewards,
  type GrowthRewardsData,
} from "../../../components/growth-rewards";
import { PageIntro } from "../../../components/page-intro";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "邀请、年卡与积分" };

export default async function RewardsPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Faccount%2Frewards");
  const dashboard = await loadGrowthDashboard(
    getWebDatabase(),
    principal.accountId,
  );
  const data: GrowthRewardsData = {
    consumerInvite: {
      ...dashboard.consumerInvite,
      expiresAt: dashboard.consumerInvite.expiresAt?.toISOString() ?? null,
      registeredAt: dashboard.consumerInvite.registeredAt?.toISOString() ?? null,
    },
    filterCodes: dashboard.filterCodes.map((code) => ({
      ...code,
      createdAt: code.createdAt.toISOString(),
      expiresAt: code.expiresAt.toISOString(),
      redeemedAt: code.redeemedAt?.toISOString() ?? null,
    })),
    filterCodesIssuedThisYear: dashboard.filterCodesIssuedThisYear,
    isFilter: dashboard.isFilter,
    pointsBalances: dashboard.pointsBalances,
    pointsEntries: dashboard.pointsEntries.map((entry) => ({
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      entryType: entry.entryType,
      id: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
    })),
  };
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>管理 Consumer 邀请、Filter 年卡和真实现金续费积分。</p>}
        eyebrow="我的 / 增长权益"
        title="邀请、年卡与积分"
      />
      <GrowthRewards data={data} />
    </div>
  );
}
