import type { Metadata } from "next";

import { AccountSecurityForm } from "../../../components/account-security-form";
import { AccountSettingsShell } from "../../../components/account-settings-shell";
import { LoginModuleFallback } from "../../../components/login-module";
import { loadAccountOverview } from "../../../server/account";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "安全" };

export default async function AccountSecurityPage() {
  const principal = await getPagePrincipal();
  if (!principal) {
    return <LoginModuleFallback returnTo="/account/security" />;
  }

  const account = await loadAccountOverview(getWebDatabase(), principal.accountId);
  if (!account) return <LoginModuleFallback returnTo="/account/security" />;

  return (
    <AccountSettingsShell
      active="security"
      description="管理密码和当前浏览器的登录状态。"
      isFilter={principal.isFilter}
      title="安全"
    >
      <AccountSecurityForm
        email={account.email}
        hasPassword={account.hasPassword}
      />
    </AccountSettingsShell>
  );
}
