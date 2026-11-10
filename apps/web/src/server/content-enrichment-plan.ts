import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { summaryReadyNotificationDedupeKey } from "@attention/contracts";
import { accounts, and, collections, contentAliases, contentIdentities, contents, domains, eq, filterProfiles,
  inArray, inputAttempts, or, setAccountContext, sql, type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { ContentEnrichmentServiceError, assertEnrichmentEligible, enrichmentResolvedIdentity, normalizeContentEnrichmentInput,
  submitContentEnrichmentInputSchema } from "./content-enrichment-model";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const date = z.iso.datetime();
const contentSchema = z.object({ id: z.uuid(), updatedAt: date, title: z.string().max(500).nullable(),
  outboundUrl: z.string().min(1).max(4096), normalizedUrl: z.string().min(1).max(4096), source: z.string().max(100),
  contentStatus: z.enum(["active", "merged"]), publicSafetyStatus: z.enum(["allowed", "blocked"]),
  communityModerationStatus: z.enum(["clear", "hidden", "pending_review"]), takedownStatus: z.enum(["none", "removed"]),
  summaryStatus: z.enum(["pending", "ready", "failed", "hidden", "unavailable"]), summaryHash: hash,
  firstPublicAt: date.nullable(), visibilityVersion: z.number().int().nonnegative(),
}).strict();
const collectionSchema = z.object({ id: z.uuid(), contentId: z.uuid(), accountId: z.uuid(), domainId: z.uuid(),
  collectionStatus: z.enum(["active", "deleted"]), visibility: z.enum(["private", "public"]),
  moderationStatus: z.enum(["clear", "blocked"]), sourceChannel: z.enum(["web", "wechat"]),
  collectedAt: date, publicSince: date.nullable(), filterRevokedAt: date.nullable(), updatedAt: date,
}).strict();
export const enrichmentSnapshotSchema = z.object({ accountId: z.uuid(), owned: contentSchema, winner: contentSchema,
  ownedCollection: collectionSchema, winnerCollection: collectionSchema.nullable(),
  identity: z.object({ id: z.uuid(), contentId: z.uuid(), active: z.boolean(), dedupeKey: z.string().min(1).max(8192) }).strict().nullable(),
  relationshipsHash: hash, attemptsHash: hash, affectedAttemptCount: z.number().int().nonnegative(),
  aliasRelation: z.enum(["none", "same", "conflict"]), winnerHasParent: z.boolean(), ownedHasChildren: z.boolean(),
  ownedHasActiveIdentity: z.boolean(), accountActive: z.boolean(), filterActive: z.boolean(), domainActive: z.boolean(),
}).strict();
export type ContentEnrichmentSnapshot = z.infer<typeof enrichmentSnapshotSchema>;
const effectsSchema = z.object({ winnerContentId: z.uuid(), winnerCollectionId: z.uuid().nullable(), claimIdentity: z.boolean(),
  linkAlias: z.boolean(), createWinnerCollection: z.boolean(), restoreWinnerCollection: z.boolean(),
  softDeleteCollectionId: z.uuid().nullable(), resultingVisibility: z.enum(["private", "public"]),
  effectivelyPublic: z.boolean(), resultingFilterRevokedAt: date.nullable(), resultingModeration: z.enum(["clear", "blocked"]),
  resultingSourceChannel: z.enum(["web", "wechat"]), promoteSourceChannel: z.boolean(), writeSharedSummary: z.boolean(),
  notification: z.object({ mode: z.enum(["none", "queue_if_missing"]), dedupeKey: z.string().max(128),
    audience: z.literal("existing_eligible_wechat_collectors") }).strict(),
}).strict();
export const contentEnrichmentPlanSchema = z.object({ version: z.literal(1), input: submitContentEnrichmentInputSchema,
  snapshot: enrichmentSnapshotSchema, effects: effectsSchema, fingerprint: hash }).strict();
export type ContentEnrichmentPlan = z.infer<typeof contentEnrichmentPlanSchema>;
export class ContentEnrichmentPlanError extends ContentEnrichmentServiceError {
  constructor(code: "enrichment_plan_invalid" | "enrichment_target_changed" | "enrichment_target_unavailable" |
    "enrichment_notification_target_unavailable") { super(code, 409); this.name = "ContentEnrichmentPlanError"; }
}
export function enrichmentStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(enrichmentStableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${enrichmentStableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function enrichmentHash(namespace: string, value: unknown): string {
  return createHash("sha256").update(`attention:reviewed-enrichment:${namespace}:v1\0`).update(enrichmentStableJson(value)).digest("hex");
}
function effectsFor(snapshot: ContentEnrichmentSnapshot): z.infer<typeof effectsSchema> {
  const { owned, winner, ownedCollection: source, winnerCollection: existing } = snapshot;
  const merge = owned.id !== winner.id, target = existing ?? source;
  const visibility = merge && (source.visibility === "public" || target.visibility === "public") ? "public" : target.visibility;
  const moderation = merge && (source.moderationStatus === "blocked" || target.moderationStatus === "blocked") ? "blocked" : target.moderationStatus;
  const writeSharedSummary = winner.summaryStatus !== "ready";
  const promoteSourceChannel = merge && source.sourceChannel === "wechat" && target.sourceChannel === "web";
  const sourceChannel = promoteSourceChannel ? "wechat" : target.sourceChannel;
  return { winnerContentId: winner.id, winnerCollectionId: existing?.id ?? (merge ? null : source.id),
    claimIdentity: snapshot.identity === null, linkAlias: merge && snapshot.aliasRelation === "none",
    createWinnerCollection: merge && !existing, restoreWinnerCollection: merge && existing?.collectionStatus === "deleted",
    softDeleteCollectionId: merge ? source.id : null, resultingVisibility: visibility,
    effectivelyPublic: visibility === "public" && moderation === "clear" && target.filterRevokedAt === null &&
      snapshot.accountActive && snapshot.filterActive && snapshot.domainActive && winner.contentStatus === "active" &&
      winner.publicSafetyStatus === "allowed" && winner.communityModerationStatus === "clear" && winner.takedownStatus === "none",
    resultingFilterRevokedAt: target.filterRevokedAt, resultingModeration: moderation, resultingSourceChannel: sourceChannel, promoteSourceChannel, writeSharedSummary,
    notification: { mode: writeSharedSummary && (source.sourceChannel === "wechat" || sourceChannel === "wechat") ? "queue_if_missing" : "none",
      dedupeKey: summaryReadyNotificationDedupeKey(winner.id), audience: "existing_eligible_wechat_collectors" },
  };
}
export function buildContentEnrichmentPlan(rawInput: unknown, rawSnapshot: unknown): ContentEnrichmentPlan {
  const input = normalizeContentEnrichmentInput(rawInput), snapshot = enrichmentSnapshotSchema.parse(rawSnapshot);
  const identity = enrichmentResolvedIdentity(input.resolved_url);
  if (!identity || input.content_id !== snapshot.owned.id || snapshot.ownedCollection.contentId !== snapshot.owned.id ||
      snapshot.ownedCollection.accountId !== snapshot.accountId || snapshot.ownedCollection.collectionStatus !== "active" ||
      !snapshot.accountActive || (snapshot.identity && (!snapshot.identity.active || snapshot.identity.dedupeKey !== identity.dedupeKey)) ||
      snapshot.winner.id !== (snapshot.identity?.contentId ?? snapshot.owned.id) ||
      (snapshot.winner.id === snapshot.owned.id && (enrichmentStableJson(snapshot.winner) !== enrichmentStableJson(snapshot.owned) ||
        enrichmentStableJson(snapshot.winnerCollection) !== enrichmentStableJson(snapshot.ownedCollection))) ||
      (snapshot.winnerCollection && (snapshot.winnerCollection.accountId !== snapshot.accountId || snapshot.winnerCollection.contentId !== snapshot.winner.id)))
    throw new ContentEnrichmentPlanError("enrichment_target_unavailable");
  for (const content of [snapshot.owned, snapshot.winner]) assertEnrichmentEligible({ ...content,
    collectionId: snapshot.ownedCollection.id, sourceChannel: snapshot.ownedCollection.sourceChannel });
  if (snapshot.owned.id !== snapshot.winner.id && (snapshot.aliasRelation === "conflict" || snapshot.winnerHasParent ||
      snapshot.ownedHasChildren || !snapshot.ownedHasActiveIdentity)) throw new ContentEnrichmentPlanError("enrichment_target_unavailable");
  const effects = effectsFor(snapshot);
  const body = { version: 1 as const, input, snapshot, effects };
  return { ...body, fingerprint: enrichmentHash("plan", body) };
}
/** Strict pure parsing. Encrypted storage, not this parser or its hash, proves provenance. */
export function parseContentEnrichmentPlan(value: unknown): ContentEnrichmentPlan {
  try {
    const parsed = contentEnrichmentPlanSchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 32768) throw new Error("oversize");
    const rebuilt = buildContentEnrichmentPlan(parsed.input, parsed.snapshot);
    if (enrichmentStableJson(rebuilt) !== enrichmentStableJson(parsed)) throw new Error("mismatch");
    return rebuilt;
  } catch { throw new ContentEnrichmentPlanError("enrichment_plan_invalid"); }
}
const iso = (value: Date | null) => value?.toISOString() ?? null;
function contentSnapshot(row: typeof contents.$inferSelect): ContentEnrichmentSnapshot["owned"] {
  return { id: row.id, updatedAt: row.updatedAt.toISOString(), title: row.title, outboundUrl: row.outboundUrl,
    normalizedUrl: row.normalizedUrl, source: row.source, contentStatus: row.contentStatus, publicSafetyStatus: row.publicSafetyStatus,
    communityModerationStatus: row.communityModerationStatus, takedownStatus: row.takedownStatus, summaryStatus: row.summaryStatus,
    summaryHash: enrichmentHash("existing-summary", [row.aiSummary, row.aiTags, row.title]),
    firstPublicAt: iso(row.firstPublicAt), visibilityVersion: row.visibilityVersion };
}
function collectionSnapshot(row: typeof collections.$inferSelect): ContentEnrichmentSnapshot["ownedCollection"] {
  return { id: row.id, contentId: row.contentId, accountId: row.accountId, domainId: row.domainId,
    collectionStatus: row.collectionStatus, visibility: row.visibility, moderationStatus: row.moderationStatus,
    sourceChannel: row.sourceChannel, collectedAt: row.collectedAt.toISOString(), publicSince: iso(row.publicSince),
    filterRevokedAt: iso(row.filterRevokedAt), updatedAt: row.updatedAt.toISOString() };
}
/** SELECT-only domain preview. The transaction-local owner context is not a business write. */
export async function loadContentEnrichmentPlan(db: AttentionDatabase, accountId: string, rawInput: unknown): Promise<ContentEnrichmentPlan> {
  const input = normalizeContentEnrichmentInput(rawInput), identity = enrichmentResolvedIdentity(input.resolved_url);
  if (!identity) throw new ContentEnrichmentPlanError("enrichment_target_unavailable");
  return db.transaction(async tx => {
    await setAccountContext(tx, accountId);
    const [ownedCollection] = await tx.select().from(collections).where(and(eq(collections.accountId, accountId),
      eq(collections.contentId, input.content_id), eq(collections.collectionStatus, "active"))).limit(1);
    const [owned] = await tx.select().from(contents).where(eq(contents.id, input.content_id)).limit(1);
    const [identityRow] = await tx.select().from(contentIdentities).where(eq(contentIdentities.dedupeKey, identity.dedupeKey)).limit(1);
    if (!ownedCollection || !owned) throw new ContentEnrichmentPlanError("enrichment_target_unavailable");
    const winnerId = identityRow?.contentId ?? owned.id;
    const [winner] = await tx.select().from(contents).where(eq(contents.id, winnerId)).limit(1);
    const [winnerCollection] = await tx.select().from(collections).where(and(eq(collections.accountId, accountId), eq(collections.contentId, winnerId))).limit(1);
    if (!winner) throw new ContentEnrichmentPlanError("enrichment_target_unavailable");
    const ids = [...new Set([owned.id, winner.id])].sort();
    const aliases = await tx.select().from(contentAliases).where(or(inArray(contentAliases.aliasContentId, ids), inArray(contentAliases.primaryContentId, ids))).orderBy(contentAliases.id);
    const identities = await tx.select().from(contentIdentities).where(inArray(contentIdentities.contentId, ids)).orderBy(contentIdentities.id);
    const attempts = await tx.select({ id: inputAttempts.id, updatedAt: inputAttempts.updatedAt,
      resultContentId: inputAttempts.resultContentId, resultCollectionId: inputAttempts.resultCollectionId }).from(inputAttempts)
      .where(and(eq(inputAttempts.accountId, accountId), eq(inputAttempts.resultContentId, owned.id))).orderBy(inputAttempts.id);
    const [account] = await tx.select({ status: accounts.status }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const [filter] = await tx.select({ active: filterProfiles.active, revokedAt: filterProfiles.revokedAt }).from(filterProfiles).where(eq(filterProfiles.accountId, accountId)).limit(1);
    const [domain] = await tx.select({ active: domains.active }).from(domains).where(eq(domains.id, winnerCollection?.domainId ?? ownedCollection.domainId)).limit(1);
    const alias = aliases.find(row => row.aliasContentId === owned.id);
    return buildContentEnrichmentPlan(input, { accountId, owned: contentSnapshot(owned), winner: contentSnapshot(winner),
      ownedCollection: collectionSnapshot(ownedCollection), winnerCollection: winnerCollection ? collectionSnapshot(winnerCollection) : null,
      identity: identityRow ? { id: identityRow.id, contentId: identityRow.contentId, active: identityRow.active, dedupeKey: identityRow.dedupeKey } : null,
      relationshipsHash: enrichmentHash("relationships", JSON.parse(JSON.stringify({ aliases, identities }))),
      attemptsHash: enrichmentHash("attempts", JSON.parse(JSON.stringify(attempts))), affectedAttemptCount: attempts.length,
      aliasRelation: !alias ? "none" : alias.active && alias.primaryContentId === winner.id ? "same" : "conflict",
      winnerHasParent: aliases.some(row => row.active && row.aliasContentId === winner.id),
      ownedHasChildren: aliases.some(row => row.active && row.primaryContentId === owned.id),
      ownedHasActiveIdentity: identities.some(row => row.active && row.contentId === owned.id),
      accountActive: account?.status === "active", filterActive: filter?.active === true && filter.revokedAt === null, domainActive: domain?.active === true,
    });
  });
}
/** Existing outer reviewed-action authority locks precede these target locks. */
export async function lockAndRevalidateContentEnrichmentPlan(tx: AttentionTransaction, accountId: string,
  rawPlan: ContentEnrichmentPlan): Promise<ContentEnrichmentPlan> {
  const plan = parseContentEnrichmentPlan(rawPlan);
  if (accountId !== plan.snapshot.accountId) throw new ContentEnrichmentPlanError("enrichment_target_changed");
  await setAccountContext(tx, accountId);
  // Account FK fencing prevents new owned collections/attempts during the exact effect set check.
  await tx.execute(sql`select id from accounts where id = ${accountId}::uuid for update`);
  const ids = [...new Set([plan.snapshot.owned.id, plan.snapshot.winner.id])].sort();
  // Same content advisory locks as attention_link_owned_content_alias, before row locks.
  for (const id of ids) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}::text, 0))`);
  for (const id of ids) await tx.execute(sql`select id from contents where id = ${id}::uuid for update`);
  await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.accountId, accountId), inArray(collections.contentId, ids))).orderBy(collections.id).for("update");
  await tx.select({ id: contentIdentities.id }).from(contentIdentities).where(or(inArray(contentIdentities.contentId, ids),
    eq(contentIdentities.dedupeKey, enrichmentResolvedIdentity(plan.input.resolved_url)!.dedupeKey))).orderBy(contentIdentities.id).for("update");
  await tx.select({ id: inputAttempts.id }).from(inputAttempts).where(and(eq(inputAttempts.accountId, accountId),
    eq(inputAttempts.resultContentId, plan.snapshot.owned.id))).orderBy(inputAttempts.id).for("update");
  const current = await loadContentEnrichmentPlan(tx, accountId, plan.input);
  if (current.fingerprint !== plan.fingerprint) throw new ContentEnrichmentPlanError("enrichment_target_changed");
  return current;
}
