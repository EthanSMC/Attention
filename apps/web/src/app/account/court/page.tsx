import { listModerationCourtCases } from "@attention/db";
import type { Metadata } from "next";
import Link from "next/link";

import {
  ModerationCourt,
  type ModerationCourtItem,
} from "../../../components/moderation-court";
import { LoginModuleFallback } from "../../../components/login-module";
import { PageIntro } from "../../../components/page-intro";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Filter 小法庭" };

export default async function ModerationCourtPage() {
  const principal = await getPagePrincipal();
  if (!principal) return <LoginModuleFallback returnTo="/account/court" />;
  if (!principal.isFilter) {
    return (
      <div className="page-shell page-shell--form">
        <PageIntro
          description={<p>只有当前有效 Filter 可以查看案件和投票。</p>}
          eyebrow="我的 / 小法庭"
          title="Filter 权限必需"
        />
        <Link className="button button--secondary" href="/account">返回我的</Link>
      </div>
    );
  }
  const cases = await listModerationCourtCases(getWebDatabase(), {
    accountId: principal.accountId,
  });
  const items: ModerationCourtItem[] = cases.map((item) => ({
    ...item,
    openedAt: item.openedAt.toISOString(),
    votingEndsAt: item.votingEndsAt.toISOString(),
  }));
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>一人一票且不可改票；满 24 小时后按有效 Filter 的简单多数裁决。</p>}
        eyebrow="我的 / 小法庭"
        title="Filter 小法庭"
      />
      <ModerationCourt cases={items} />
    </div>
  );
}
