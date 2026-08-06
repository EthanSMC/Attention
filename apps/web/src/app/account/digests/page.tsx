import type { Metadata } from "next";

import { AccountSettingsShell } from "../../../components/account-settings-shell";
import { DigestSettingsForm } from "../../../components/digest-settings-form";
import { LoginModuleFallback } from "../../../components/login-module";
import { getWebDatabase } from "../../../server/db";
import { loadDigestSettings } from "../../../server/digest-settings";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "日报" };

export default async function DigestSettingsPage() {
  const principal = await getPagePrincipal();
  if (!principal) return <LoginModuleFallback returnTo="/account/digests" />;
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
