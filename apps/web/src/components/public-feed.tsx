import Link from "next/link";

import type { PublicContent } from "../lib/attention";
import { PublicContentCard } from "./content-card";
import { LockIcon } from "./icons";
import { LoginLink } from "./login-link";
import { MasonryFeed } from "./masonry-feed";
import { ViewSwitcher, type ViewMode } from "./view-switcher";

export type FeedView = ViewMode;

export function PublicFeed({
  contents,
  isAuthenticated,
  isLimited,
  previewLimit,
  view,
}: {
  contents: PublicContent[];
  isAuthenticated: boolean;
  isLimited: boolean;
  previewLimit: number;
  view: FeedView;
}) {
  return (
    <section aria-label="AI 公开内容" className="public-feed" id="public-feed">
      <div className="feed-toolbar">
        <div className="feed-toolbar__copy">
          <strong>最新收藏</strong>
          <span>
            {isLimited ? `预览前 ${previewLimit} 条` : `${contents.length} 条`} · 按首次公开时间
          </span>
        </div>
        <ViewSwitcher
          ariaLabel="内容显示方式"
          hrefs={{ cards: "/ai?view=cards", list: "/ai?view=list" }}
          value={view}
        />
      </div>

      {contents.length > 0 ? (
        view === "cards" ? (
          <MasonryFeed contents={contents} />
        ) : (
          <div className="content-list" role="list">
            {contents.map((content) => (
              <div className="content-list__item" key={content.id} role="listitem">
                <PublicContentCard content={content} display="list" />
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="empty-state">
          <p className="empty-state__eyebrow">还没有公开收藏</p>
          <h2>第一张卡片会从这里开始</h2>
          <p>受邀 Filter 收藏并选择公开后，内容会按时间出现在这里。</p>
        </div>
      )}

      {isLimited ? (
        <section className="feed-paywall">
          <div aria-hidden="true" className="feed-paywall__icon">
            <LockIcon />
          </div>
          <p className="feed-paywall__eyebrow">公开流预览到这里</p>
          <h2>解锁完整发现</h2>
          <p>
            Member 可以浏览完整的高质量公开收藏，并使用日报、筛选、订阅与高级 Agent 能力。
          </p>
          {isAuthenticated ? (
            <Link className="button button--primary" href="/membership?return_to=%2Fai">
              查看会员方案
            </Link>
          ) : (
            <LoginLink
              className="button button--primary"
              returnTo="/membership?return_to=%2Fai"
            >
              登录并查看会员
            </LoginLink>
          )}
          <div aria-hidden="true" className="feed-paywall__silhouettes">
            <span />
            <span />
            <span />
          </div>
        </section>
      ) : contents.length > 0 ? (
        <div className="feed-end">
          <p>已显示全部内容</p>
        </div>
      ) : null}
    </section>
  );
}
