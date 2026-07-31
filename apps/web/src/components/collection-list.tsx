"use client";

import { useMemo, useState } from "react";

import type {
  CollectionItem,
  EffectiveVisibility,
  Visibility,
} from "../lib/attention";
import { httpCollectAdapter } from "../lib/http-attention";
import { ArrowUpRightIcon } from "./icons";
import {
  EnrichmentBadge,
  SourceSignal,
  VisibilityBadge,
} from "./signal-elements";

type CollectionFilter = "all" | "public" | "private" | "processing";

const filterLabels: Record<CollectionFilter, string> = {
  all: "全部",
  public: "公开",
  private: "私密",
  processing: "摘要待处理",
};

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

function effectiveVisibilityAfterChange(visibility: Visibility): EffectiveVisibility {
  return visibility;
}

function visibilityHelp(item: CollectionItem, allowPublic: boolean) {
  if (item.effectiveVisibility === "paused") {
    return allowPublic
      ? "这条收藏仍保持暂停；重新公开后才会回到公共入口，也可以直接改为私密。"
      : "Filter 权限已暂停。这条收藏不会出现在公共入口；现在可以改为私密，恢复权限后仍需本人重新公开。";
  }

  if (item.effectiveVisibility === "blocked") {
    return "该收藏已被管理员阻断，不会出现在公共入口，也不能通过重发或切换绕过。";
  }

  return item.visibility === "public"
    ? "会出现在 AI 公开流；改为私密后停止未来公开曝光。"
    : "只在你的收藏中出现，不进入公共标签或 MCP 计数。";
}

function CollectionCard({
  allowPublic,
  item,
  onVisibilityChange,
}: {
  allowPublic: boolean;
  item: CollectionItem;
  onVisibilityChange: (id: string, visibility: Visibility) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const immutable = item.effectiveVisibility === "blocked";
  const canRestorePublication =
    allowPublic && item.effectiveVisibility === "paused";

  async function changeVisibility(visibility: Visibility) {
    const restoringPublication =
      visibility === "public" && item.effectiveVisibility === "paused";
    if (
      saving ||
      immutable ||
      (visibility === item.visibility && !restoringPublication)
    ) {
      return;
    }
    setSaving(true);
    try {
      await onVisibilityChange(item.id, visibility);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="collection-card">
      <SourceSignal
        initial={item.sourceInitial}
        source={item.source}
        tone={item.sourceTone}
      />
      <div className="collection-card__body">
        <div className="collection-card__statuses">
          <VisibilityBadge effectiveVisibility={item.effectiveVisibility} />
          <EnrichmentBadge status={item.summaryStatus} />
        </div>

        <p className="collection-card__source">
          {item.source}
          {item.author ? <span> · {item.author}</span> : null}
        </p>
        <h2>
          {item.outboundHref ? (
            <a href={item.outboundHref} rel="noopener noreferrer" target="_blank">
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </h2>

        <section aria-label="AI 生成摘要" className="ai-summary ai-summary--compact">
          <span className="ai-summary__compact-label">AI 摘要</span>
          {item.summaryStatus === "ready" && item.summary ? <p>{item.summary}</p> : null}
          {item.summaryStatus === "processing" ? (
            <p className="summary-placeholder">AI 摘要尚未就绪，链接已经保存。</p>
          ) : null}
          {item.summaryStatus === "unavailable" ? (
            <p className="summary-placeholder">
              {item.outboundHref
                ? "当前没有可用的 AI 摘要，仍可查看原文。"
                : "当前没有可用的 AI 摘要。"}
            </p>
          ) : null}
        </section>

        <div className="collection-card__meta">
          <time dateTime={item.collectedAt}>
            收藏于 {dateTimeFormatter.format(new Date(item.collectedAt))}
          </time>
          {item.outboundHref ? (
            <a
              className="text-link"
              href={item.outboundHref}
              rel="noopener noreferrer"
              target="_blank"
            >
              查看原文
              <ArrowUpRightIcon />
            </a>
          ) : (
            <span className="outbound-unavailable">原文当前不可访问</span>
          )}
        </div>

        <details className="visibility-details">
          <summary>公开设置</summary>
          <fieldset aria-describedby={`visibility-help-${item.id}`} disabled={saving || immutable}>
            <legend className="sr-only">更改“{item.title}”的公开状态</legend>
            {allowPublic ? (
              <label>
                <input
                  checked={item.visibility === "public"}
                  name={`visibility-${item.id}`}
                  onChange={() => void changeVisibility("public")}
                  type="radio"
                  value="public"
                />
                <span>公开</span>
              </label>
            ) : null}
            <label>
              <input
                checked={item.visibility === "private"}
                name={`visibility-${item.id}`}
                onChange={() => void changeVisibility("private")}
                type="radio"
                value="private"
              />
              <span>私密</span>
            </label>
          </fieldset>
          {canRestorePublication ? (
            <button
              className="button button--secondary button--compact visibility-restore"
              disabled={saving}
              onClick={() => void changeVisibility("public")}
              type="button"
            >
              {saving ? "正在重新公开…" : "重新公开"}
            </button>
          ) : null}
          <p className="visibility-details__help" id={`visibility-help-${item.id}`}>
            {visibilityHelp(item, allowPublic)}
          </p>
          {saving ? <p aria-live="polite" className="saving-note">正在保存公开设置…</p> : null}
        </details>
      </div>
    </article>
  );
}

export function CollectionList({
  allowPublic = true,
  initialItems,
}: {
  allowPublic?: boolean;
  initialItems: CollectionItem[];
}) {
  const [items, setItems] = useState(initialItems);
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const [announcement, setAnnouncement] = useState("");

  const filteredItems = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "processing") {
      return items.filter((item) => item.summaryStatus === "processing");
    }
    return items.filter((item) => item.effectiveVisibility === filter);
  }, [filter, items]);

  async function updateVisibility(id: string, visibility: Visibility) {
    try {
      await httpCollectAdapter.updateVisibility({ collectionId: id, visibility });
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                visibility,
                effectiveVisibility: effectiveVisibilityAfterChange(visibility),
              }
            : item,
        ),
      );
      setAnnouncement(visibility === "public" ? "已公开收藏。" : "已改为私密收藏。");
    } catch {
      setAnnouncement("公开设置没有保存，原状态保持不变。");
    }
  }

  return (
    <section aria-labelledby="collection-list-title" className="collection-list">
      <div className="collection-toolbar">
        <div>
          <h2 id="collection-list-title">收藏列表</h2>
          <p>{items.length} 条有效收藏</p>
        </div>
        <div aria-label="筛选收藏" className="filter-tabs" role="group">
          {(Object.keys(filterLabels) as CollectionFilter[]).map((value) => (
            <button
              aria-pressed={filter === value}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {filterLabels[value]}
            </button>
          ))}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {filteredItems.length > 0 ? (
        <div className="collection-list__items">
          {filteredItems.map((item) => (
            <CollectionCard
              allowPublic={allowPublic}
              item={item}
              key={item.id}
              onVisibilityChange={updateVisibility}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <span aria-hidden="true" className="empty-state__signal" />
          <h3>这个范围里还没有收藏</h3>
          <p>切换筛选，或收藏一条值得保留的链接。</p>
        </div>
      )}
    </section>
  );
}
