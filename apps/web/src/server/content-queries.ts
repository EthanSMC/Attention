import type {
  CollectionItem,
  EnrichmentStatus,
  PublicContent,
  SourceTone,
} from "../lib/attention";
import { resolveAccountCapabilities } from "@attention/auth";
import {
  accounts,
  and,
  collections,
  contents,
  desc,
  eq,
  filterProfiles,
  publicContentAttributionsCurrent,
  publicContentsCurrent,
  sql,
  type AttentionDatabase,
} from "@attention/db";

import type { AgentCandidate } from "./agent-core";

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
  const [capabilities, rows] = await Promise.all([
    resolveAccountCapabilities(db, accountId),
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
      return tx
        .select({
          aiSummary: contents.aiSummary,
          aiTags: contents.aiTags,
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
          publicContentId: publicContentsCurrent.id,
          source: contents.source,
          attentionId: accounts.attentionId,
          summaryStatus: contents.summaryStatus,
          takedownStatus: contents.takedownStatus,
          title: contents.title,
          visibility: collections.visibility,
        })
        .from(collections)
        .innerJoin(contents, eq(contents.id, collections.contentId))
        .innerJoin(accounts, eq(accounts.id, collections.accountId))
        .leftJoin(filterProfiles, eq(filterProfiles.accountId, collections.accountId))
        .leftJoin(publicContentsCurrent, eq(publicContentsCurrent.id, contents.id))
        .where(
          and(
            eq(collections.accountId, accountId),
            eq(collections.collectionStatus, "active"),
          ),
        )
        .orderBy(sql`${collections.collectedAt} DESC`);
    }),
  ]);

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
    const derivedVisible = capabilities.isMember || row.publicContentId !== null;
    return {
      author: row.author,
      collectedAt: row.collectedAt.toISOString(),
      effectiveVisibility,
      filters: row.filterDisplayName
        ? [
            {
              attentionId: row.attentionId,
              displayName: row.filterDisplayName,
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
      summary: derivedVisible ? row.aiSummary : null,
      summaryStatus: derivedVisible ? uiSummaryStatus(row.summaryStatus) : "unavailable",
      tags: derivedVisible ? row.aiTags : [],
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
      aiTags: publicContentsCurrent.aiTags,
      author: publicContentsCurrent.author,
      attentionId: publicContentAttributionsCurrent.attentionId,
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
    .orderBy(
      desc(publicContentsCurrent.firstPublicAt),
      desc(publicContentsCurrent.publicId),
    );

  const byContent = new Map<
    string,
    { content: PublicContent; stableHandles: Set<string> }
  >();
  for (const row of rows) {
    const key = row.publicId;
    const existing = byContent.get(key);
    const filter = {
      attentionId: row.attentionId,
      displayName: row.displayName,
      initials: filterInitials(row.displayName),
    };
    if (existing) {
      if (!existing.stableHandles.has(row.stableHandle)) {
        existing.content.filters.push(filter);
        existing.stableHandles.add(row.stableHandle);
      }
      continue;
    }

    const source = sourcePresentation(row.source, row.outboundUrl);
    byContent.set(key, {
      content: {
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
        tags: row.aiTags,
        title: row.title ?? fallbackTitle(row.outboundUrl, source.name),
      },
      stableHandles: new Set([row.stableHandle]),
    });
  }
  return [...byContent.values()].map(({ content }) => content);
}

/**
 * Returns only the current account's safe active collections plus rows from
 * the security-barrier public view. Internal content keys are used solely to
 * deduplicate the same canonical Content across those two authorized scopes.
 */
export async function loadAgentCandidates(
  db: AttentionDatabase,
  accountId: string,
): Promise<AgentCandidate[]> {
  const mine = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    return tx
      .select({
        aiSummary: contents.aiSummary,
        aiTags: contents.aiTags,
        author: contents.author,
        collectionId: collections.id,
        contentId: contents.id,
        outboundUrl: contents.outboundUrl,
        source: contents.source,
        summaryStatus: contents.summaryStatus,
        title: contents.title,
      })
      .from(collections)
      .innerJoin(contents, eq(contents.id, collections.contentId))
      .where(and(
        eq(collections.accountId, accountId),
        eq(collections.collectionStatus, "active"),
        eq(collections.moderationStatus, "clear"),
        eq(contents.contentStatus, "active"),
        eq(contents.publicSafetyStatus, "allowed"),
        eq(contents.takedownStatus, "none"),
      ));
  });
  const mineKeys = new Set(mine.map((row) => row.contentId));
  const publicRows = await db
    .select({
      aiSummary: publicContentsCurrent.aiSummary,
      aiTags: publicContentsCurrent.aiTags,
      author: publicContentsCurrent.author,
      contentId: publicContentsCurrent.id,
      outboundUrl: publicContentsCurrent.outboundUrl,
      publicId: publicContentsCurrent.publicId,
      source: publicContentsCurrent.source,
      summaryStatus: publicContentsCurrent.summaryStatus,
      title: publicContentsCurrent.title,
    })
    .from(publicContentsCurrent);

  const ownCandidates = mine.map<AgentCandidate>((row) => {
    const source = sourcePresentation(row.source, row.outboundUrl);
    return {
      author: row.author,
      href: `/out/mine/${row.collectionId}`,
      id: row.collectionId,
      key: row.contentId,
      scope: "mine",
      source: source.name,
      summary: row.summaryStatus === "ready" ? row.aiSummary : null,
      tags: row.summaryStatus === "hidden" ? [] : row.aiTags,
      title: row.title ?? fallbackTitle(row.outboundUrl, source.name),
    };
  });
  const publicByContent = new Map<string, AgentCandidate>();
  for (const row of publicRows) {
    if (mineKeys.has(row.contentId) || publicByContent.has(row.contentId)) continue;
    const source = sourcePresentation(row.source, row.outboundUrl);
    publicByContent.set(row.contentId, {
      author: row.author,
      href: `/out/public/${row.publicId}`,
      id: row.publicId,
      key: row.contentId,
      scope: "public",
      source: source.name,
      summary: row.summaryStatus === "ready" ? row.aiSummary : null,
      tags: row.summaryStatus === "hidden" ? [] : row.aiTags,
      title: row.title ?? fallbackTitle(row.outboundUrl, source.name),
    });
  }
  return [...ownCandidates, ...publicByContent.values()];
}
