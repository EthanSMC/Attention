"use client";

import { useMemo, useState } from "react";

import type {
  CollectionItem,
  EffectiveVisibility,
  Visibility,
} from "../lib/attention";
import { httpCollectAdapter } from "../lib/http-attention";
import { ContentCardBody, ContentTagStrip } from "./content-card";
import { GlobeIcon, LockIcon, WarningIcon } from "./icons";
import { MasonryGrid } from "./masonry-grid";
import { VisibilityBadge } from "./signal-elements";
import { ViewSwitcher, type ViewMode } from "./view-switcher";

type CollectionFilter = "all" | "public" | "private";
type CollectionView = ViewMode;

const filterLabels: Record<CollectionFilter, string> = {
  all: "全部",
  public: "公开",
  private: "私密",
};

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

function effectiveVisibilityAfterChange(
  visibility: Visibility,
): EffectiveVisibility {
  return visibility;
}

function visibilityAction(item: CollectionItem, allowPublic: boolean) {
  if (allowPublic) {
    if (item.effectiveVisibility === "public") {
      return {
        ariaLabel: "当前公开，点击改为私密",
        visibility: "private" as const,
      };
    }

    if (item.effectiveVisibility === "private") {
      return {
        ariaLabel: "当前私密，点击公开收藏",
        visibility: "public" as const,
      };
    }

    if (item.effectiveVisibility === "paused") {
      return {
        ariaLabel: "公开已暂停，点击重新公开",
        visibility: "public" as const,
      };
    }
  }

  if (!allowPublic && item.effectiveVisibility === "paused") {
    return {
      ariaLabel: "公开已暂停，点击改为私密",
      visibility: "private" as const,
    };
  }

  return null;
}

function visibilityControl(item: CollectionItem) {
  const config = {
    blocked: { icon: WarningIcon, label: "已阻断" },
    paused: { icon: WarningIcon, label: "已暂停" },
    private: { icon: LockIcon, label: "私密" },
    public: { icon: GlobeIcon, label: "公开" },
  } as const;
  return config[item.effectiveVisibility];
}

function CollectionCard({
  allowPublic,
  display,
  item,
  onVisibilityChange,
}: {
  allowPublic: boolean;
  display: CollectionView;
  item: CollectionItem;
  onVisibilityChange: (id: string, visibility: Visibility) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const immutable = item.effectiveVisibility === "blocked";
  const action = visibilityAction(item, allowPublic);
  const control = visibilityControl(item);
  const VisibilityIcon = control.icon;

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
    <article
      className={`content-card content-card--${display === "cards" ? "card" : "list"} collection-card`}
    >
      <ContentCardBody collectedAt={item.collectedAt} content={item} />
      <footer className="content-card__footer collection-card__footer">
        <ContentTagStrip
          showCapability={false}
          tags={item.tags}
          title={item.title}
        />

        <div className="collection-card__owner-meta">
          {action ? (
            <button
              aria-busy={saving}
              aria-label={
                saving ? `${action.ariaLabel}，正在保存` : action.ariaLabel
              }
              aria-pressed={
                item.effectiveVisibility === "public"
                  ? true
                  : item.effectiveVisibility === "private"
                    ? false
                    : undefined
              }
              className={`visibility-toggle visibility-toggle--${item.effectiveVisibility}`}
              disabled={saving}
              onClick={() => void changeVisibility(action.visibility)}
              type="button"
            >
              <span aria-hidden="true" className="visibility-toggle__track">
                <span className="visibility-toggle__thumb" />
              </span>
              <span className="visibility-toggle__label">
                <VisibilityIcon />
                {saving ? "保存中" : control.label}
              </span>
            </button>
          ) : (
            <VisibilityBadge effectiveVisibility={item.effectiveVisibility} />
          )}
          <time dateTime={item.collectedAt}>
            收藏于 {dateTimeFormatter.format(new Date(item.collectedAt))}
          </time>
        </div>
      </footer>
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
  const [view, setView] = useState<CollectionView>("cards");
  const [announcement, setAnnouncement] = useState("");

  const filteredItems = useMemo(() => {
    if (filter === "all") return items;
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
        <div className="collection-toolbar__copy">
          <h2 id="collection-list-title">收藏</h2>
          <p>
            {filteredItems.length} / {items.length} 条
          </p>
        </div>
        <div className="collection-toolbar__controls">
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
          <ViewSwitcher
            ariaLabel="收藏显示方式"
            onChange={setView}
            value={view}
          />
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {filteredItems.length > 0 ? (
        view === "cards" ? (
          <MasonryGrid>
            {filteredItems.map((item) => (
              <div className="masonry-feed__item" key={item.id} role="listitem">
                <CollectionCard
                  allowPublic={allowPublic}
                  display={view}
                  item={item}
                  onVisibilityChange={updateVisibility}
                />
              </div>
            ))}
          </MasonryGrid>
        ) : (
          <div className="content-list collection-content-list" role="list">
            {filteredItems.map((item) => (
              <div className="content-list__item" key={item.id} role="listitem">
                <CollectionCard
                  allowPublic={allowPublic}
                  display={view}
                  item={item}
                  onVisibilityChange={updateVisibility}
                />
              </div>
            ))}
          </div>
        )
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
