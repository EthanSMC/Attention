import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CollectionList } from "../../components/collection-list";
import { ProfileIdentityEditor } from "../../components/profile-identity-editor";
import { loadAccountOverview } from "../../server/account";
import { loadMyCollections } from "../../server/content-queries";
import { getWebDatabase } from "../../server/db";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的",
  description: "管理 Attention 账号、会员与 Agent 连接。",
};

export default async function AccountPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Faccount");
  const db = getWebDatabase();
  const [account, collections] = await Promise.all([
    loadAccountOverview(db, principal.accountId),
    loadMyCollections(db, principal.accountId),
  ]);
  if (!account) redirect("/login?return_to=%2Faccount");

  const publicCount = collections.filter(
    (item) => item.effectiveVisibility === "public",
  ).length;
  const readyCount = collections.filter(
    (item) => item.summaryStatus === "ready",
  ).length;

  return (
    <div className="page-shell page-shell--profile page-shell--primary">
      <header className="account-profile">
        <p className="account-profile__eyebrow eyebrow">我的</p>
        <ProfileIdentityEditor
          attentionId={account.attentionId}
          avatarUrl={account.avatarUrl}
          displayName={account.displayName}
          isFilter={principal.isFilter}
          isMember={principal.isMember}
        />

        <Link
          className="button button--secondary account-profile__edit"
          href="/account/settings"
        >
          设置
        </Link>

        <dl className="account-profile__stats">
          <div>
            <dt>收藏</dt>
            <dd>{collections.length}</dd>
          </div>
          <div>
            <dt>公开</dt>
            <dd>{publicCount}</dd>
          </div>
          <div>
            <dt>AI 已整理</dt>
            <dd>{readyCount}</dd>
          </div>
        </dl>
      </header>

      <section className="account-profile__collections" id="collections">
        <CollectionList
          allowPublic={principal.isFilter}
          initialItems={collections}
        />
      </section>
    </div>
  );
}
