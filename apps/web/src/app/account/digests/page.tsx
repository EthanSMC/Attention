import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountSettingsShell } from "../../../components/account-settings-shell";
import { DigestSettingsForm } from "../../../components/digest-settings-form";
import { getWebDatabase } from "../../../server/db";
import { loadDigestSettings } from "../../../server/digest-settings";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "日报" };

export default async function DigestSettingsPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Faccount%2Fdigests");
  const settings = await loadDigestSettings(getWebDatabase(), principal.accountId);
  return (
    <AccountSettingsShell
      active="digests"
      description="先选择要订阅的日报，再设置报童的送达时间和渠道。"
      isFilter={principal.isFilter}
      title="日报"
    >
      <DigestSettingsForm
        deliveryEmail={principal.primaryEmail}
        eligible={principal.isMember || principal.isFilter}
        initial={settings}
      />
    </AccountSettingsShell>
  );
}
