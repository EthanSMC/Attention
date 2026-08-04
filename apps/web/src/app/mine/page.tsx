import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CollectionList } from "../../components/collection-list";
import { PageIntro } from "../../components/page-intro";
import { loadMyCollections } from "../../server/content-queries";
import { getWebDatabase } from "../../server/db";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的收藏",
  description: "查看收藏的处理状态、打开原文并管理公开范围。",
};

export default async function MinePage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/login?return_to=%2Fmine");
  const collections = await loadMyCollections(getWebDatabase(), principal.accountId);

  return (
    <div className="page-shell page-shell--mine">
      <PageIntro
        description={
          <p>
            可见性决定谁能发现这条收藏；AI 状态只说明当前有没有可用摘要，两者互不替代。
          </p>
        }
        eyebrow="个人知识层"
        title="我的收藏"
      />
      <CollectionList allowPublic={principal.isFilter} initialItems={collections} />
    </div>
  );
}
