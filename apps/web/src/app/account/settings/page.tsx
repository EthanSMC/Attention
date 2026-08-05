import { loadGrowthDashboard } from "@attention/auth";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountSettingsShell } from "../../../components/account-settings-shell";
import { AccountSettingsForm } from "../../../components/account-settings-form";
import {
  GrowthRewards,
  type GrowthRewardsData,
} from "../../../components/growth-rewards";
import { loadAccountOverview } from "../../../server/account";
import { getWebDatabase } from "../../../server/db";
import { loadCurrentSubscription } from "../../../server/membership";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "账号资料" };

export default async function AccountSettingsPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Faccount%2Fsettings");
  const db = getWebDatabase();
  const [account, currentSubscription, dashboard] = await Promise.all([
    loadAccountOverview(db, principal.accountId),
    loadCurrentSubscription(db, principal.accountId),
    loadGrowthDashboard(db, principal.accountId),
  ]);
  if (!account) redirect("/login?return_to=%2Faccount%2Fsettings");

  const rewardsData: GrowthRewardsData = {
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

  const currentPeriodEndLabel = currentSubscription
    ? new Intl.DateTimeFormat("zh-CN", {
        day: "numeric",
        month: "long",
        timeZone: "Asia/Shanghai",
        year: "numeric",
      }).format(currentSubscription.currentPeriodEnd)
    : null;

  return (
    <AccountSettingsShell
      active="account"
      description="管理你的公开身份、订阅和增长权益。"
      isFilter={principal.isFilter}
      title="账号资料"
    >
      <AccountSettingsForm
        attentionId={account.attentionId}
        attentionIdChangedAt={account.attentionIdChangedAt}
        displayName={account.displayName}
        membership={{
          hasMemberEntitlement: principal.isMember,
          subscription: currentSubscription
            ? {
                cancelAtPeriodEnd: currentSubscription.cancelAtPeriodEnd,
                currentPeriodEndLabel: currentPeriodEndLabel ?? "",
                status: currentSubscription.status,
              }
            : null,
        }}
      />
      <section
        aria-labelledby="growth-rewards-title"
        className="settings-embedded-section"
      >
        <header className="settings-embedded-section__heading">
          <p className="settings-card__eyebrow">增长权益</p>
          <h2 id="growth-rewards-title">邀请与积分</h2>
          <p>邀请新用户、管理 Filter 年卡，并查看续费积分。</p>
        </header>
        <GrowthRewards data={rewardsData} />
      </section>
    </AccountSettingsShell>
  );
}
