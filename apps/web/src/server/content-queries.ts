import type {
  CollectionItem,
  EnrichmentStatus,
  PublicContent,
  SourceTone,
} from "../lib/attention";
import {
  accounts,
  and,
  collections,
  contents,
  eq,
  filterProfiles,
  publicContentAttributionsCurrent,
  publicContentsCurrent,
  sql,
  type AttentionDatabase,
} from "@attention/db";

function sourcePresentation(
  source: string,
  outboundUrl: string,
): { initial: string; name: string; tone: SourceTone } {
  const known: Record<string, { initial: string; name: string; tone: SourceTone }> = {
    douyin: { initial: "抖", name: "抖音", tone: "coral" },
    wechat_official_article: {
      initial: "微",
      name: "微信公众号",
      tone: "mint",
    },
    xiaohongshu: { initial: "小", name: "小红书", tone: "coral" },
  };
  const presentation = known[source];
  if (presentation) return presentation;

  let host = "网页";
  try {
    host = new URL(outboundUrl).hostname.replace(/^www\./u, "");
  } catch {
    // Persisted URLs were validated at collection time. Keep a safe label if a
    // legacy row does not parse instead of reflecting its value into the UI.
  }
  return {
    initial: host.slice(0, 1).toUpperCase() || "网",
    name: host,
    tone: "gold",
  };
}

function fallbackTitle(outboundUrl: string, sourceName: string): string {
  try {
    const url = new URL(outboundUrl);
    const segment = decodeURIComponent(url.pathname)
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/[-_]+/gu, " ")
      .trim();
    return segment || `${sourceName}内容`;
  } catch {
    return `${sourceName}内容`;
  }
}

function uiSummaryStatus(
  value: "failed" | "hidden" | "pending" | "ready" | "unavailable",
): EnrichmentStatus {
  if (value === "ready") return "ready";
  if (value === "pending") return "processing";
  return "unavailable";
}

function filterInitials(value: string): string {
  return value
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("") || "F";
}

export async function loadMyCollections(
  db: AttentionDatabase,
  accountId: string,
): Promise<CollectionItem[]> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    return tx
      .select({
        aiSummary: contents.aiSummary,
        author: contents.author,
        collectedAt: collections.collectedAt,
        collectionId: collections.id,
        filterDisplayName: filterProfiles.displayName,
        filterRevokedAt: collections.filterRevokedAt,
        firstPublicAt: contents.firstPublicAt,
        moderationStatus: collections.moderationStatus,
        outboundUrl: contents.outboundUrl,
        publicSafetyStatus: contents.publicSafetyStatus,
        publishedAt: contents.publishedAt,
        source: contents.source,
        stableHandle: accounts.stableHandle,
        summaryStatus: contents.summaryStatus,
        takedownStatus: contents.takedownStatus,
        title: contents.title,
        visibility: collections.visibility,
      })
      .from(collections)
      .innerJoin(contents, eq(contents.id, collections.contentId))
      .innerJoin(accounts, eq(accounts.id, collections.accountId))
      .leftJoin(filterProfiles, eq(filterProfiles.accountId, collections.accountId))
      .where(
        and(
          eq(collections.accountId, accountId),
          eq(collections.collectionStatus, "active"),
        ),
      )
      .orderBy(sql`${collections.collectedAt} DESC`);
  });

  return rows.map((row) => {
    const source = sourcePresentation(row.source, row.outboundUrl);
    const blocked =
      row.moderationStatus === "blocked" ||
      row.publicSafetyStatus === "blocked" ||
      row.takedownStatus === "removed";
    const effectiveVisibility = blocked
      ? "blocked"
      : row.visibility === "public" && row.filterRevokedAt
        ? "paused"
        : row.visibility;
    return {
      author: row.author,
      collectedAt: row.collectedAt.toISOString(),
      effectiveVisibility,
      filters: row.filterDisplayName
        ? [
            {
              displayName: row.filterDisplayName,
              handle: row.stableHandle,
              initials: filterInitials(row.filterDisplayName),
            },
          ]
        : [],
      firstPublicAt: (row.firstPublicAt ?? row.collectedAt).toISOString(),
      id: row.collectionId,
      outboundHref: blocked ? null : `/out/mine/${row.collectionId}`,
      publishedAt: row.publishedAt?.toISOString().slice(0, 10) ?? null,
      source: source.name,
      sourceInitial: source.initial,
      sourceTone: source.tone,
      summary: row.aiSummary,
      summaryStatus: uiSummaryStatus(row.summaryStatus),
      tags: [],
      title: row.title ?? fallbackTitle(row.outboundUrl, source.name),
      visibility: row.visibility,
    };
  });
}

export async function loadPublicContents(
  db: AttentionDatabase,
): Promise<PublicContent[]> {
  const rows = await db
    .select({
      aiSummary: publicContentsCurrent.aiSummary,
      author: publicContentsCurrent.author,
      displayName: publicContentAttributionsCurrent.displayName,
      firstPublicAt: publicContentsCurrent.firstPublicAt,
      outboundUrl: publicContentsCurrent.outboundUrl,
      publicId: publicContentsCurrent.publicId,
      publishedAt: publicContentsCurrent.publishedAt,
      source: publicContentsCurrent.source,
      stableHandle: publicContentAttributionsCurrent.stableHandle,
      summaryStatus: publicContentsCurrent.summaryStatus,
      title: publicContentsCurrent.title,
    })
    .from(publicContentsCurrent)
    .innerJoin(
      publicContentAttributionsCurrent,
      eq(publicContentAttributionsCurrent.contentId, publicContentsCurrent.id),
    )
    .orderBy(sql`${publicContentsCurrent.firstPublicAt} DESC`);

  const byContent = new Map<string, PublicContent>();
  for (const row of rows) {
    const key = row.publicId;
    const existing = byContent.get(key);
    const filter = {
      displayName: row.displayName,
      handle: row.stableHandle,
      initials: filterInitials(row.displayName),
    };
    if (existing) {
      if (!existing.filters.some((item) => item.handle === filter.handle)) {
        existing.filters.push(filter);
      }
      continue;
    }

    const source = sourcePresentation(row.source, row.outboundUrl);
    byContent.set(key, {
      author: row.author,
      filters: [filter],
      firstPublicAt: row.firstPublicAt.toISOString(),
      id: row.publicId,
      outboundHref: `/out/public/${row.publicId}`,
      publishedAt: row.publishedAt?.toISOString().slice(0, 10) ?? null,
      source: source.name,
      sourceInitial: source.initial,
      sourceTone: source.tone,
      summary: row.aiSummary,
      summaryStatus: uiSummaryStatus(row.summaryStatus),
      tags: [],
      title: row.title ?? fallbackTitle(row.outboundUrl, source.name),
    });
  }
  return [...byContent.values()];
}
