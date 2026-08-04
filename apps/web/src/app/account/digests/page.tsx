import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DigestSettingsForm } from "../../../components/digest-settings-form";
import { PageIntro } from "../../../components/page-intro";
import { getWebDatabase } from "../../../server/db";
import { loadDigestSettings } from "../../../server/digest-settings";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "日报订阅" };

export default async function DigestSettingsPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Faccount%2Fdigests");
  const settings = await loadDigestSettings(getWebDatabase(), principal.accountId);
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>每天只发送仍公开、仍符合你实时权益的新内容；没有新增则不发送。</p>}
        eyebrow="我的 / 日报"
        title="Domain 订阅"
      />
      <DigestSettingsForm
        eligible={principal.isMember || principal.isFilter}
        initial={settings}
      />
    </div>
  );
}
