import { createHash } from "node:crypto";
import { and, collections, contentAliases, contentIdentities, contents, domains, eq, inArray, jobs, or, type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { z } from "zod";
import { ContentTypeSchema, SourceAdapterIdSchema } from "@attention/contracts";
import type { ResolvedCandidate } from "./collection-service";

export type CollectionVisibility = "private" | "public";
export type CollectionEffectDatabase = AttentionDatabase | AttentionTransaction;
type JsonRow = Record<string, unknown>;
export interface CollectionEffectPlan {
  version: 1;
  accountId: string;
  candidate: ResolvedCandidate;
  requestedVisibility: CollectionVisibility;
  snapshot: {
    identities: JsonRow[];
    aliases: JsonRow[];
    contents: JsonRow[];
    collections: JsonRow[];
    domain: JsonRow;
    metadataJob: JsonRow | null;
  };
  effects: {
    targetContentId: string | null;
    targetCollectionId: string | null;
    targetDisposition: "new" | "reused" | "restored";
    resultingVisibility: CollectionVisibility;
    resultingModeration: string;
    resultingDomainId: string;
    pendingAliasContentIds: string[];
    mergedCollectionIds: string[];
    /** Collections created only to establish an owned alias, then merged in this transaction. */
    mergedNewAliasContentIds: string[];
    aliasCollectionDispositions: Record<string, "new" | "reused" | "restored">;
    sharedOutboundChange: boolean;
    /** Persisted destination used by /out/mine after Core resolves aliases. */
    resultingOutboundUrl: string;
    metadataJob: "schedule" | "existing";
  };
  digest: string;
}

/** Canonical JSON also normalizes database Dates for encrypted artifact round trips. */
export function collectionPlanCanonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export function collectionPlanDigest(value: unknown): string {
  return createHash("sha256").update(collectionPlanCanonical(value)).digest("hex");
}
function rows<T extends object>(items: T[]): JsonRow[] {
  return JSON.parse(JSON.stringify(items.map((row) => row).sort((a, b) => collectionPlanCanonical(a).localeCompare(collectionPlanCanonical(b))))) as JsonRow[];
}

/** Read only. Caller must establish the owner's database context before calling. */
export async function loadCollectionEffectPlan(db: CollectionEffectDatabase, accountId: string, candidate: ResolvedCandidate, requestedVisibility: CollectionVisibility): Promise<CollectionEffectPlan> {
  const keys = [...new Set([candidate.identity.dedupeKey, ...candidate.aliasIdentities.map((i) => i.dedupeKey)])];
  const identities = await db.select().from(contentIdentities).where(inArray(contentIdentities.dedupeKey, keys));
  const primaryIdentity = identities.find((i) => i.dedupeKey === candidate.identity.dedupeKey && i.active);
  const initialIds = [...new Set(identities.map((i) => i.contentId))];
  const parents = initialIds.length ? await db.select().from(contentAliases).where(inArray(contentAliases.aliasContentId, initialIds)) : [];
  const targetContentId = parents.find((a) => a.aliasContentId === primaryIdentity?.contentId && a.active)?.primaryContentId ?? primaryIdentity?.contentId ?? null;
  const ids = [...new Set([...initialIds, ...parents.map((a) => a.primaryContentId), ...(targetContentId ? [targetContentId] : [])])];
  const aliases = ids.length ? await db.select().from(contentAliases).where(or(inArray(contentAliases.aliasContentId, ids), inArray(contentAliases.primaryContentId, ids))) : [];
  const allIds = [...new Set([...ids, ...aliases.flatMap((a) => [a.aliasContentId, a.primaryContentId])])];
  const contentRows = allIds.length ? await db.select({ id: contents.id, source: contents.source, normalizedUrl: contents.normalizedUrl, outboundUrl: contents.outboundUrl, enrichmentStatus: contents.enrichmentStatus, contentStatus: contents.contentStatus, publicSafetyStatus: contents.publicSafetyStatus, takedownStatus: contents.takedownStatus, communityModerationStatus: contents.communityModerationStatus, visibilityVersion: contents.visibilityVersion }).from(contents).where(inArray(contents.id, allIds)) : [];
  const collectionRows = allIds.length ? await db.select().from(collections).where(and(eq(collections.accountId, accountId), inArray(collections.contentId, allIds))) : [];
  const [domain] = await db.select({ id: domains.id, slug: domains.slug, active: domains.active }).from(domains).where(and(eq(domains.slug, "ai"), eq(domains.active, true))).limit(1);
  if (!domain) throw new Error("ai_domain_not_configured");
  const [metadataJob] = targetContentId ? await db.select({ id: jobs.id, idempotencyKey: jobs.idempotencyKey }).from(jobs).where(eq(jobs.idempotencyKey, `content.metadata.v1:${targetContentId}`)).limit(1) : [];
  const target = collectionRows.find((c) => c.contentId === targetContentId);
  const targetContent = contentRows.find((c) => c.id === targetContentId);
  const sharedOutboundChange = !!targetContent && candidate.identity.adapter === "xiaohongshu" &&
    candidate.outboundUrl !== candidate.identity.normalizedUrl && targetContent.source === "xiaohongshu" &&
    targetContent.normalizedUrl === candidate.identity.normalizedUrl && targetContent.outboundUrl !== candidate.outboundUrl;
  const pendingAliasContentIds = [...new Set(candidate.aliasIdentities.flatMap((identity) => {
    const found = identities.find((i) => i.dedupeKey === identity.dedupeKey && i.active);
    return found && found.contentId !== targetContentId ? [found.contentId] : [];
  }))].sort();
  const aliasIds = new Set([...pendingAliasContentIds, ...aliases.filter((a) => a.active && a.primaryContentId === targetContentId).map((a) => a.aliasContentId)]);
  const merging = collectionRows.filter((c) => aliasIds.has(c.contentId) && c.contentId !== targetContentId && (c.collectionStatus === "active" || pendingAliasContentIds.includes(c.contentId)));
  const activeTarget = target?.collectionStatus === "active";
  const resultingVisibility = (activeTarget ? target.visibility : requestedVisibility) === "public" || merging.some((c) => (c.collectionStatus === "active" ? c.visibility : requestedVisibility) === "public") || (pendingAliasContentIds.some((id) => !collectionRows.some((c) => c.contentId === id)) && requestedVisibility === "public") ? "public" : "private";
  const relatedIdentities = allIds.length ? await db.select().from(contentIdentities).where(or(inArray(contentIdentities.contentId, allIds), inArray(contentIdentities.dedupeKey, keys))) : identities;
  const snapshot = { identities: rows(relatedIdentities), aliases: rows(aliases), contents: rows(contentRows), collections: rows(collectionRows), domain: rows([domain])[0]!, metadataJob: metadataJob ? rows([metadataJob])[0]! : null };
  const effects: CollectionEffectPlan["effects"] = {
    targetContentId, targetCollectionId: target?.id ?? null,
    targetDisposition: !target ? "new" : activeTarget ? "reused" : "restored",
    resultingVisibility,
    resultingModeration: [target, ...merging].some((c) => c?.moderationStatus === "blocked") ? "blocked" : "clear",
    resultingDomainId: activeTarget ? target.domainId : domain.id,
    pendingAliasContentIds,
    mergedCollectionIds: merging.map((c) => c.id).sort(),
    mergedNewAliasContentIds: pendingAliasContentIds.filter((id) => !collectionRows.some((c) => c.contentId === id)),
    aliasCollectionDispositions: Object.fromEntries(pendingAliasContentIds.map((id) => { const c = collectionRows.find((row) => row.contentId === id); return [id, !c ? "new" : c.collectionStatus === "active" ? "reused" : "restored"]; })),
    sharedOutboundChange,
    resultingOutboundUrl: !targetContent || sharedOutboundChange ? candidate.outboundUrl : targetContent.outboundUrl,
    metadataJob: metadataJob ? "existing" : "schedule",
  };
  const body = { version: 1 as const, accountId, candidate, requestedVisibility, snapshot, effects };
  return parseCollectionEffectPlan({ ...body, digest: collectionPlanDigest(body) });
}

const id = z.string().uuid();
const short = z.string().max(256);
const url = z.string().max(8192);
const date = z.string().datetime();
const visibility = z.enum(["private", "public"]);
const disposition = z.enum(["new", "reused", "restored"]);
const identity = z.object({ adapter: SourceAdapterIdSchema, adapterVersion: short, contentType: ContentTypeSchema, identityKind: z.enum(["platform_id", "normalized_url"]), identityValue: url, dedupeKey: url, normalizedUrl: url }).strict();
const candidateSchema = z.object({ aliasIdentities: z.array(identity).max(16), identity, outboundUrl: url, observedUrl: url, selectedUrl: url, redirectChain: z.array(url).max(32), displayHost: short, resolutionStatus: z.enum(["pending", "resolved"]) }).strict();
const planSchema = z.object({
  version: z.literal(1), accountId: id, candidate: candidateSchema, requestedVisibility: visibility,
  snapshot: z.object({
    identities: z.array(z.object({ id, contentId: id, dedupeKey: url, identityKind: short, normalizedUrl: url, sourceAdapter: short, adapterVersion: short, active: z.boolean(), createdAt: date }).strict()).max(64),
    aliases: z.array(z.object({ id, aliasContentId: id, primaryContentId: id, aliasDedupeKey: url, ruleVersion: short, reasonCode: short, active: z.boolean(), createdAt: date, disabledAt: date.nullable() }).strict()).max(32),
    contents: z.array(z.object({ id, source: short, normalizedUrl: url, outboundUrl: url, enrichmentStatus: short, contentStatus: short, publicSafetyStatus: short, takedownStatus: short, communityModerationStatus: short, visibilityVersion: z.number().int() }).strict()).max(32),
    collections: z.array(z.object({ id, accountId: id, contentId: id, domainId: id, visibility, collectedAt: date, publicSince: date.nullable(), sourceChannel: short, collectionStatus: short, filterRevokedAt: date.nullable(), moderationStatus: short, createdAt: date, updatedAt: date }).strict()).max(32),
    domain: z.object({ id, slug: short, active: z.boolean() }).strict(),
    metadataJob: z.object({ id, idempotencyKey: short.nullable() }).strict().nullable(),
  }).strict(),
  effects: z.object({ targetContentId: id.nullable(), targetCollectionId: id.nullable(), targetDisposition: disposition, resultingVisibility: visibility, resultingModeration: short, resultingDomainId: id, pendingAliasContentIds: z.array(id).max(32), mergedCollectionIds: z.array(id).max(32), mergedNewAliasContentIds: z.array(id).max(32), aliasCollectionDispositions: z.record(id, disposition).refine((v) => Object.keys(v).length <= 32), sharedOutboundChange: z.boolean(), resultingOutboundUrl: url, metadataJob: z.enum(["schedule", "existing"]) }).strict(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Bounded strict serialization boundary, not authorization for model-authored plans. */
export function parseCollectionEffectPlan(value: unknown): CollectionEffectPlan {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 24_000) throw new Error("collection_effect_plan_too_large");
  const plan = planSchema.parse(value);
  const { digest, ...body } = plan;
  if (collectionPlanDigest(body) !== digest) throw new Error("invalid_collection_effect_plan");
  return plan;
}
