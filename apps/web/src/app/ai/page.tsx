import type { Metadata } from "next";
import Link from "next/link";

import { PublicContentCard } from "../../components/content-card";
import { PlusIcon } from "../../components/icons";
import { PageIntro } from "../../components/page-intro";
import { loadPublicContents } from "../../server/content-queries";
import { getWebDatabase } from "../../server/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI 公开流",
  description: "由 Filter 公开筛选、由 AI 自动整理的时间顺序信息流。",
};

const dayFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  timeZone: "Asia/Shanghai",
});

function dayKey(date: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(date));
}

export default async function AiPage() {
  const publicContents = await loadPublicContents(getWebDatabase());
  const groups = publicContents.reduce(
    (result, content) => {
      const key = dayKey(content.firstPublicAt);
      const existing = result.get(key) ?? [];
      existing.push(content);
      result.set(key, existing);
      return result;
    },
    new Map<string, typeof publicContents>(),
  );

  return (
    <div className="page-shell page-shell--stream">
      <PageIntro
        aside={
          <Link className="button button--primary button--compact" href="/collect">
            <PlusIcon />
            收藏链接
          </Link>
        }
        description={
          <>
            <p>
              由受邀 Filter 筛入公开链接，Attention 负责安全提取，并明确标注当前的 AI 摘要状态。
            </p>
            <p className="endorsement-note">
              收藏只表示“值得保留或可能有用”，不代表收藏者已经读完、完全认同或强烈推荐。
            </p>
          </>
        }
        eyebrow="AI Domain / 公开"
        title="人筛选，AI 整理。"
      />

      <div className="stream-layout">
        <aside className="stream-context" aria-label="信息流说明">
          <p className="stream-context__label">当前规则</p>
          <p>严格按首次公开时间排列，没有热门权重或个性化推荐。</p>
          <a href="#public-feed">跳到公开内容</a>
        </aside>

        <section aria-label="AI 公开内容" className="public-feed" id="public-feed">
          {Array.from(groups.entries()).map(([date, contents]) => (
            <section aria-label={dayFormatter.format(new Date(`${date}T12:00:00+08:00`))} className="feed-day" key={date}>
              <div className="feed-day__marker">
                <time dateTime={date}>{dayFormatter.format(new Date(`${date}T12:00:00+08:00`))}</time>
                <span>按首次公开时间</span>
              </div>
              <div className="feed-day__cards">
                {contents.map((content) => (
                  <PublicContentCard content={content} key={content.id} />
                ))}
              </div>
            </section>
          ))}

          <div className="feed-end">
            <span aria-hidden="true" />
            <p>这就是目前全部公开内容。</p>
          </div>
        </section>
      </div>
    </div>
  );
}
