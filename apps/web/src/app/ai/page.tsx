import type { Metadata } from "next";

import { DomainSwitcher } from "../../components/domain-switcher";
import { PageIntro } from "../../components/page-intro";
import { PublicFeed, type FeedView } from "../../components/public-feed";
import { loadPublicContents } from "../../server/content-queries";
import { getWebDatabase } from "../../server/db";
import {
  hasCompletePublicAccess,
  publicFeedPreviewLimit,
} from "../../server/public-access";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "发现",
  description: "由 Filter 公开筛选、由 AI 自动整理的时间顺序信息流。",
};

export default async function AiPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const params = await searchParams;
  const view: FeedView = params.view === "list" ? "list" : "cards";
  const principal = await getPagePrincipal();
  const allPublicContents = await loadPublicContents(getWebDatabase());
  const previewLimit = publicFeedPreviewLimit();
  const completeAccess = hasCompletePublicAccess(principal);
  const publicContents = completeAccess
    ? allPublicContents
    : allPublicContents.slice(0, previewLimit);
  const isLimited = !completeAccess && allPublicContents.length > previewLimit;

  return (
    <div className="page-shell page-shell--stream page-shell--primary">
      <PageIntro
        description={<p>由人收藏，AI 整理。阅读始终回到原作者。</p>}
        eyebrow="发现"
        title={<DomainSwitcher current="ai" />}
      />

      <PublicFeed
        contents={publicContents}
        isAuthenticated={principal !== null}
        isLimited={isLimited}
        previewLimit={previewLimit}
        view={view}
      />
    </div>
  );
}
