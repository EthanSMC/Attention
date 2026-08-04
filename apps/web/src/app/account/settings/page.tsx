import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountSettingsForm } from "../../../components/account-settings-form";
import { PageIntro } from "../../../components/page-intro";
import { loadAccountOverview } from "../../../server/account";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "账号设置" };

export default async function AccountSettingsPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Faccount%2Fsettings");
  const account = await loadAccountOverview(getWebDatabase(), principal.accountId);
  if (!account) redirect("/login?return_to=%2Faccount%2Fsettings");
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>网站 Session、OAuth、API Key 和 Channel 绑定彼此独立。</p>}
        eyebrow="我的 / 设置"
        title="账号设置"
      />
      <AccountSettingsForm {...account} />
    </div>
  );
}
