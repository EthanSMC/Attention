import type { PublicContent } from "../lib/attention";
import { ArrowUpRightIcon } from "./icons";
import { EnrichmentBadge } from "./signal-elements";
import { SourceLogo } from "./source-logo";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});

const collectedFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});

function Summary({ content }: { content: PublicContent }) {
  if (content.summaryStatus === "processing") {
    return <p className="summary-placeholder">AI 摘要尚未就绪，链接已可访问。</p>;
  }

  if (content.summaryStatus === "unavailable" || !content.summary) {
    return <p className="summary-placeholder">当前没有可用的 AI 摘要，请查看原文。</p>;
  }

  return <p>{content.summary}</p>;
}

export function PublicContentCard({
  content,
  display = "card",
}: {
  content: PublicContent;
  display?: "card" | "list";
}) {
  const cardBody = (
    <>
      <div className="content-card__body">
        <SourceLogo source={content.source} />
        <div className="content-card__source-line">
          {content.author ? <span>{content.author}</span> : null}
          {content.publishedAt ? (
            <time dateTime={content.publishedAt}>
              {dateFormatter.format(new Date(`${content.publishedAt}T00:00:00+08:00`))}
            </time>
          ) : null}
          <time dateTime={content.firstPublicAt}>
            {collectedFormatter.format(new Date(content.firstPublicAt))} 收藏
          </time>
        </div>
        <h2>{content.title}</h2>
        <section aria-label="AI 生成摘要" className="ai-summary">
          <div className="ai-summary__label">
            <EnrichmentBadge status={content.summaryStatus} />
          </div>
          <Summary content={content} />
        </section>
        {content.outboundHref ? (
          <span className="text-link text-link--primary">
            查看原文
            <ArrowUpRightIcon />
          </span>
        ) : (
          <span className="outbound-unavailable">原文当前不可访问</span>
        )}
      </div>
    </>
  );

  return (
    <article className={`content-card content-card--${display}`}>
      {content.outboundHref ? (
        <a
          aria-label={`查看原文：${content.title}（在新标签页打开）`}
          className="content-card__primary-link"
          href={content.outboundHref}
          rel="noopener noreferrer"
          target="_blank"
        >
          {cardBody}
        </a>
      ) : (
        <div className="content-card__primary-link">{cardBody}</div>
      )}

      <footer className="content-card__footer">
        {content.tags.length > 0 ? (
          <div className="tag-strip">
            <ul aria-label={`${content.title} 的标签`} className="tag-list">
              {content.tags.map((tag) => (
                <li className="tag-link" key={tag}>
                  #{tag}
                </li>
              ))}
            </ul>
            <span className="tag-capability" title="接入会员权益后可按标签筛选">
              会员筛选
            </span>
          </div>
        ) : null}

        <div className="content-card__attribution">
          <div aria-label="公开收藏者" className="filter-stack">
            <div aria-hidden="true" className="filter-stack__avatars">
              {content.filters.slice(0, 3).map((filter) => (
                <span className="filter-avatar" key={filter.handle} title={filter.displayName}>
                  {filter.initials}
                </span>
              ))}
            </div>
            <span>
              由 @{content.filters[0]?.handle ?? "filter"}
              {content.filters.length > 1 ? ` 等 ${content.filters.length} 人` : ""} 收藏
            </span>
          </div>
        </div>
      </footer>
    </article>
  );
}
