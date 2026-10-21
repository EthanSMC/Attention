import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveAccountCapabilities } from "@attention/auth";
import {
  accounts, and, apiCredentials, browserReadGrants, collectionPrivateEnrichments,
  collections, contents, eq, gt, isNull, oauthAccessTokens, or, setAccountContext, sql,
  type AttentionDatabase,
} from "@attention/db";
import { getCollectionStatus } from "./collection-status-service";
import { sourceReadIdentity } from "./collection-source-reader";
import type { AttentionToolContext } from "./attention-tool-registry";

export const browserFeatureEnabled = () => process.env.ATTENTION_DEDICATED_BROWSER_ENABLED === "true";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const grantPattern = /^att_browser_[a-f0-9]{64}$/;
export const browserGrantInputSchema = z.object({ collection_id: z.string().uuid() }).strict();
export const privateEnrichmentInputSchema = z.object({
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_revision: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().min(1).max(64)).max(8),
  idempotency_key: z.string().trim().min(8).max(128),
}).strict();
export class BrowserEnrichmentError extends Error {
  constructor(readonly code: "invalid_request" | "permission_revoked" | "source_changed" | "write_conflict" | "rate_limited", readonly status = 403) {
    super(code); this.name = "BrowserEnrichmentError";
  }
}
type GrantRow = typeof browserReadGrants.$inferSelect;
async function currentCredential(db: AttentionDatabase, grant: Pick<GrantRow, "accountId" | "credentialId" | "credentialKind">) {
  const now = new Date();
  let scopes: string[] | undefined;
  if (grant.credentialKind === "oauth") {
    const [row] = await db.select({ scopes: oauthAccessTokens.scopes }).from(oauthAccessTokens)
      .innerJoin(accounts, eq(accounts.id, oauthAccessTokens.accountId)).where(and(
        eq(oauthAccessTokens.id, grant.credentialId), eq(oauthAccessTokens.accountId, grant.accountId),
        eq(oauthAccessTokens.audience, "attention-mcp"), eq(oauthAccessTokens.status, "active"),
        isNull(oauthAccessTokens.revokedAt), gt(oauthAccessTokens.expiresAt, now), eq(accounts.status, "active"),
      )).limit(1);
    scopes = row?.scopes;
  } else if (grant.credentialKind === "pat") {
    const [row] = await db.select({ scopes: apiCredentials.scopes }).from(apiCredentials)
      .innerJoin(accounts, eq(accounts.id, apiCredentials.accountId)).where(and(
        eq(apiCredentials.id, grant.credentialId), eq(apiCredentials.accountId, grant.accountId),
        eq(apiCredentials.status, "active"), isNull(apiCredentials.revokedAt),
        or(isNull(apiCredentials.expiresAt), gt(apiCredentials.expiresAt, now)), eq(accounts.status, "active"),
      )).limit(1);
    scopes = row?.scopes;
  }
  if (!scopes?.includes("collection:read") || !scopes.includes("collection:write")) throw new BrowserEnrichmentError("permission_revoked");
  const capabilities = await resolveAccountCapabilities(db, grant.accountId, now);
  if (!capabilities.isMember && !capabilities.isFilter) throw new BrowserEnrichmentError("permission_revoked");
}

export async function issueBrowserGrant(context: AttentionToolContext, raw: unknown) {
  if (!browserFeatureEnabled()) throw new BrowserEnrichmentError("permission_revoked");
  const input = browserGrantInputSchema.safeParse(raw);
  if (!input.success) throw new BrowserEnrichmentError("invalid_request", 400);
  const principal = await context.revalidate?.();
  if (!principal || principal.accountId !== context.accountId) throw new BrowserEnrichmentError("permission_revoked");
  const db = context.getDatabase();
  const credential = { accountId: context.accountId, credentialId: context.caller.credentialId, credentialKind: context.caller.credentialKind };
  await currentCredential(db, credential);
  const status = await getCollectionStatus(db, principal, input.data);
  const identity = sourceReadIdentity(status);
  if (!identity || new URL(identity.url).protocol !== "https:") throw new BrowserEnrichmentError("source_changed", 409);
  const token = "att_browser_" + randomBytes(32).toString("hex");
  const now = new Date(), expiresAt = new Date(now.getTime() + 30 * 60_000);
  context.signal.throwIfAborted();
  await db.transaction(async tx => {
    await setAccountContext(tx, context.accountId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"browser-grant:" + context.accountId}, 0))`);
    await currentCredential(tx as unknown as AttentionDatabase, credential);
    const [prior] = await tx.select().from(browserReadGrants).where(eq(browserReadGrants.accountId, context.accountId));
    if (prior && now.getTime() - prior.createdAt.getTime() < 5000) throw new BrowserEnrichmentError("rate_limited", 429);
    const row = { ...credential, id: randomUUID(), collectionId: input.data.collection_id, grantHash: hash(token),
      sourceRevision: identity.operation, sourceUrl: identity.url, expiresAt, createdAt: now };
    await tx.insert(browserReadGrants).values(row).onConflictDoUpdate({ target: browserReadGrants.accountId, set: row });
    context.signal.throwIfAborted();
  });
  return { grant: token, collection_id: input.data.collection_id, expires_at: expiresAt.getTime(),
    source_revision: identity.operation, evidence_visibility: "account_private" as const };
}

async function resolveGrantRow(db: AttentionDatabase, token: string): Promise<GrantRow> {
  if (!browserFeatureEnabled()) throw new BrowserEnrichmentError("permission_revoked");
  if (!grantPattern.test(token)) throw new BrowserEnrichmentError("permission_revoked");
  const row = await db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.browser_grant_hash', ${hash(token)}, true)`);
    const [grant] = await tx.select().from(browserReadGrants).where(and(
      eq(browserReadGrants.grantHash, hash(token)), gt(browserReadGrants.expiresAt, new Date()),
    )).limit(1);
    return grant;
  });
  if (!row) throw new BrowserEnrichmentError("permission_revoked");
  await currentCredential(db, row);
  const status = await getCollectionStatus(db, { accountId: row.accountId }, { collection_id: row.collectionId });
  const identity = sourceReadIdentity(status);
  if (!identity || identity.operation !== row.sourceRevision || identity.url !== row.sourceUrl) throw new BrowserEnrichmentError("source_changed", 409);
  return row;
}

export async function resolveBrowserGrant(db: AttentionDatabase, token: string) {
  const row = await resolveGrantRow(db, token);
  return { grant_id: row.id, account_id: row.accountId, collection_id: row.collectionId,
    source_revision: row.sourceRevision, source_url: row.sourceUrl, expires_at: row.expiresAt.getTime() };
}

export async function savePrivateBrowserEnrichment(db: AttentionDatabase, token: string, raw: unknown) {
  const parsed = privateEnrichmentInputSchema.safeParse(raw);
  if (!parsed.success) throw new BrowserEnrichmentError("invalid_request", 400);
  const input = parsed.data, grant = await resolveGrantRow(db, token);
  if (input.source_revision !== grant.sourceRevision) throw new BrowserEnrichmentError("source_changed", 409);
  const status = await getCollectionStatus(db, { accountId: grant.accountId }, { collection_id: grant.collectionId });
  return db.transaction(async tx => {
    await setAccountContext(tx, grant.accountId);
    await tx.execute(sql`set local statement_timeout = '5000ms'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"browser-grant:" + grant.accountId}, 0))`);
    const [live] = await tx.select().from(browserReadGrants).where(and(
      eq(browserReadGrants.id, grant.id), eq(browserReadGrants.grantHash, hash(token)), gt(browserReadGrants.expiresAt, new Date()),
    )).for("update");
    if (!live) throw new BrowserEnrichmentError("permission_revoked");
    await currentCredential(tx as unknown as AttentionDatabase, live);
    const [target] = await tx.select({ collection: collections, content: contents }).from(collections)
      .innerJoin(contents, eq(contents.id, collections.contentId)).where(and(
        eq(collections.id, grant.collectionId), eq(collections.accountId, grant.accountId),
      )).for("update");
    if (!target || target.collection.updatedAt.toISOString() !== status.collection?.updated_at ||
      target.content.updatedAt.toISOString() !== status.content?.updated_at ||
      target.collection.collectionStatus !== "active" || target.collection.moderationStatus !== "clear" ||
      target.content.contentStatus !== "active" || target.content.publicSafetyStatus !== "allowed" ||
      target.content.takedownStatus !== "none" || target.content.communityModerationStatus !== "clear") throw new BrowserEnrichmentError("source_changed", 409);
    const [prior] = await tx.select().from(collectionPrivateEnrichments)
      .where(eq(collectionPrivateEnrichments.collectionId, grant.collectionId)).for("update");
    const result = { collection_id: grant.collectionId, summary_status: "ready" as const,
      evidence_visibility: "account_private" as const, title: input.title, summary: input.summary };
    if (prior) {
      if (prior.idempotencyKey === input.idempotency_key && prior.sourceRevision === input.source_revision &&
        prior.evidenceSha256 === input.evidence_sha256 && prior.title === input.title && prior.summary === input.summary &&
        JSON.stringify(prior.tags) === JSON.stringify(input.tags)) return { ...result, status: "already_saved" as const };
      // First-write wins until an explicit revision-aware edit endpoint exists.
      // A new read or LLM result cannot silently replace a prior private edit.
      throw new BrowserEnrichmentError("write_conflict", 409);
    }
    await tx.insert(collectionPrivateEnrichments).values({
      accountId: grant.accountId, collectionId: grant.collectionId, sourceRevision: grant.sourceRevision,
      evidenceSha256: input.evidence_sha256, sourceUrl: grant.sourceUrl, title: input.title,
      summary: input.summary, tags: input.tags, idempotencyKey: input.idempotency_key,
    });
    return { ...result, status: "saved" as const };
  });
}

/** Called by Attention MCP, not by Bridge. Bind the capability to the same
 * authenticated caller before accepting a private write. */
export async function submitPrivateBrowserEnrichment(context: AttentionToolContext, raw: unknown) {
  const input = privateEnrichmentInputSchema.extend({ grant: z.string().regex(grantPattern) }).strict().safeParse(raw);
  if (!input.success) throw new BrowserEnrichmentError("invalid_request", 400);
  const principal = await context.revalidate?.();
  if (!principal || principal.accountId !== context.accountId) throw new BrowserEnrichmentError("permission_revoked");
  const grant = await resolveGrantRow(context.getDatabase(), input.data.grant);
  if (grant.accountId !== context.accountId || grant.credentialId !== context.caller.credentialId ||
    grant.credentialKind !== context.caller.credentialKind) throw new BrowserEnrichmentError("permission_revoked");
  context.signal.throwIfAborted();
  const { grant: token, ...evidence } = input.data;
  return savePrivateBrowserEnrichment(context.getDatabase(), token, evidence);
}
