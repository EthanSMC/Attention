import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

import {
  and,
  bindIntents,
  channelIdentities,
  channelPendingRequests,
  eq,
  gt,
  isNull,
  type AttentionDatabase,
} from "@attention/db";

import { resolveAccountCapabilities } from "./sessions";
import { createOpaqueToken, hashOpaqueToken } from "./tokens";

export type ChannelProvider = "wechat" | "wecom" | "douyin" | "xiaohongshu";
export type ChannelAction = "collect" | "agent";
const pendingTtlMs = 10 * 60 * 1_000;

export type ChannelBindingErrorCode =
  | "binding_expired"
  | "binding_invalid"
  | "channel_already_bound"
  | "membership_required";

export class ChannelBindingError extends Error {
  readonly code: ChannelBindingErrorCode;
  constructor(code: ChannelBindingErrorCode) {
    super(code);
    this.name = "ChannelBindingError";
    this.code = code;
  }
}

function channelSecret(): string {
  const secret = process.env.ATTENTION_CHANNEL_SECRET?.trim() ?? process.env.ATTENTION_AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("ATTENTION_CHANNEL_SECRET must contain at least 32 characters");
  return secret;
}

function subjectHash(provider: ChannelProvider, appId: string, subjectId: string): string {
  return createHmac("sha256", channelSecret())
    .update("attention:channel-subject:v1\0")
    .update(provider).update("\0").update(appId).update("\0").update(subjectId)
    .digest("hex");
}

function encryptionKey(): Buffer {
  return createHash("sha256").update("attention:channel-payload:v1\0").update(channelSecret()).digest();
}

function encryptPayload(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptValue(value: string): unknown {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new ChannelBindingError("binding_invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const clear = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]);
    return JSON.parse(clear.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ChannelBindingError) throw error;
    throw new ChannelBindingError("binding_invalid");
  }
}

function decryptPayload(value: string): { action: ChannelAction; rawInput: string } {
  try {
    const parsed = decryptValue(value) as { action?: unknown; rawInput?: unknown };
    if ((parsed.action !== "collect" && parsed.action !== "agent") || typeof parsed.rawInput !== "string") {
      throw new Error("invalid payload");
    }
    return { action: parsed.action, rawInput: parsed.rawInput };
  } catch (error) {
    if (error instanceof ChannelBindingError) throw error;
    throw new ChannelBindingError("binding_invalid");
  }
}

export async function resolveChannelIdentity(
  db: AttentionDatabase,
  input: { appId: string; provider: ChannelProvider; subjectId: string },
): Promise<{ accountId: string; isFilter: boolean; isMember: boolean } | null> {
  const [identity] = await db
    .select({ accountId: channelIdentities.accountId })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.provider, input.provider),
        eq(channelIdentities.appId, input.appId),
        eq(channelIdentities.subjectIdHash, subjectHash(input.provider, input.appId, input.subjectId)),
        isNull(channelIdentities.revokedAt),
      ),
    )
    .limit(1);
  if (!identity) return null;
  const capabilities = await resolveAccountCapabilities(db, identity.accountId);
  return {
    accountId: identity.accountId,
    isFilter: capabilities.isFilter,
    isMember: capabilities.isMember,
  };
}

export async function createChannelBindIntent(
  db: AttentionDatabase,
  input: {
    action: ChannelAction;
    appId: string;
    channelMessageId: string;
    provider: ChannelProvider;
    rawInput: string;
    subjectId: string;
    now?: Date;
  },
): Promise<{ bindToken: string; expiresAt: Date; pendingRequestId: string }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + pendingTtlMs);
  const hashedSubject = subjectHash(input.provider, input.appId, input.subjectId);
  const bindToken = createOpaqueToken();
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .insert(channelPendingRequests)
      .values({
        appId: input.appId,
        channelMessageId: input.channelMessageId,
        createdAt: now,
        encryptedPayload: encryptPayload({ action: input.action, rawInput: input.rawInput }),
        expiresAt,
        provider: input.provider,
        subjectIdHash: hashedSubject,
      })
      .onConflictDoUpdate({
        target: [channelPendingRequests.provider, channelPendingRequests.appId, channelPendingRequests.channelMessageId],
        set: {
          encryptedPayload: encryptPayload({ action: input.action, rawInput: input.rawInput }),
          expiresAt,
        },
      })
      .returning({ id: channelPendingRequests.id });
    if (!pending) throw new Error("pending_request_creation_failed");
    await tx.insert(bindIntents).values({
      appId: input.appId,
      createdAt: now,
      expiresAt,
      pendingRequestId: pending.id,
      provider: input.provider,
      subjectIdHash: hashedSubject,
      tokenHash: await hashOpaqueToken(bindToken),
    });
    return { bindToken, expiresAt, pendingRequestId: pending.id };
  });
}

export interface ChannelBindPreview {
  action: ChannelAction;
  appId: string;
  expiresAt: Date;
  provider: ChannelProvider;
}

export async function inspectChannelBindIntent(
  db: AttentionDatabase,
  token: string,
  now = new Date(),
): Promise<ChannelBindPreview> {
  let tokenHash: string;
  try { tokenHash = await hashOpaqueToken(token); } catch { throw new ChannelBindingError("binding_invalid"); }
  const [row] = await db
    .select({
      appId: bindIntents.appId,
      encryptedPayload: channelPendingRequests.encryptedPayload,
      expiresAt: bindIntents.expiresAt,
      provider: bindIntents.provider,
      status: bindIntents.status,
    })
    .from(bindIntents)
    .innerJoin(channelPendingRequests, eq(channelPendingRequests.id, bindIntents.pendingRequestId))
    .where(eq(bindIntents.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.status !== "pending") throw new ChannelBindingError("binding_invalid");
  if (row.expiresAt <= now) throw new ChannelBindingError("binding_expired");
  return { action: decryptPayload(row.encryptedPayload).action, appId: row.appId, expiresAt: row.expiresAt, provider: row.provider };
}

export async function confirmChannelBindIntent(
  db: AttentionDatabase,
  input: { accountId: string; token: string; now?: Date },
): Promise<{ action: ChannelAction; rawInput: string; pendingRequestId: string }> {
  const now = input.now ?? new Date();
  let tokenHash: string;
  try { tokenHash = await hashOpaqueToken(input.token); } catch { throw new ChannelBindingError("binding_invalid"); }
  const capabilities = await resolveAccountCapabilities(db, input.accountId, now);
  if (!capabilities.isMember) throw new ChannelBindingError("membership_required");
  return db.transaction(async (tx) => {
    const [intent] = await tx.select().from(bindIntents).where(eq(bindIntents.tokenHash, tokenHash)).for("update").limit(1);
    if (!intent || intent.status !== "pending" || !intent.pendingRequestId) throw new ChannelBindingError("binding_invalid");
    if (intent.expiresAt <= now) {
      await tx.update(bindIntents).set({ status: "expired" }).where(eq(bindIntents.id, intent.id));
      throw new ChannelBindingError("binding_expired");
    }
    const [existing] = await tx
      .select({ accountId: channelIdentities.accountId })
      .from(channelIdentities)
      .where(and(
        eq(channelIdentities.provider, intent.provider),
        eq(channelIdentities.appId, intent.appId),
        eq(channelIdentities.subjectIdHash, intent.subjectIdHash),
        isNull(channelIdentities.revokedAt),
      ))
      .for("update")
      .limit(1);
    if (existing && existing.accountId !== input.accountId) {
      await tx.update(bindIntents).set({ status: "conflict" }).where(eq(bindIntents.id, intent.id));
      throw new ChannelBindingError("channel_already_bound");
    }
    if (!existing) {
      await tx.insert(channelIdentities).values({
        accountId: input.accountId,
        appId: intent.appId,
        boundAt: now,
        provider: intent.provider,
        subjectIdHash: intent.subjectIdHash,
      });
    }
    const [pending] = await tx.select().from(channelPendingRequests).where(and(
      eq(channelPendingRequests.id, intent.pendingRequestId),
      gt(channelPendingRequests.expiresAt, now),
      isNull(channelPendingRequests.consumedAt),
    )).for("update").limit(1);
    if (!pending) throw new ChannelBindingError("binding_expired");
    await tx.update(bindIntents).set({ confirmedAccountId: input.accountId, confirmedAt: now, consumedAt: now, status: "consumed" }).where(eq(bindIntents.id, intent.id));
    await tx.update(channelPendingRequests).set({ consumedAt: now }).where(eq(channelPendingRequests.id, pending.id));
    return { ...decryptPayload(pending.encryptedPayload), pendingRequestId: pending.id };
  });
}

export async function completeChannelPendingRequest(
  db: AttentionDatabase,
  pendingRequestId: string,
  result: unknown,
  now = new Date(),
): Promise<void> {
  await db
    .update(channelPendingRequests)
    .set({ encryptedResult: encryptPayload(result), processedAt: now, processingErrorCode: null })
    .where(eq(channelPendingRequests.id, pendingRequestId));
}

export async function failChannelPendingRequest(
  db: AttentionDatabase,
  pendingRequestId: string,
  errorCode: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(channelPendingRequests)
    .set({ processedAt: now, processingErrorCode: errorCode.slice(0, 100) })
    .where(eq(channelPendingRequests.id, pendingRequestId));
}

export async function readChannelPendingResult(
  db: AttentionDatabase,
  pendingRequestId: string,
): Promise<
  | { status: "pending" }
  | { errorCode: string; status: "failed" }
  | { result: unknown; status: "completed" }
  | null
> {
  const [pending] = await db
    .select({
      encryptedResult: channelPendingRequests.encryptedResult,
      processedAt: channelPendingRequests.processedAt,
      processingErrorCode: channelPendingRequests.processingErrorCode,
    })
    .from(channelPendingRequests)
    .where(eq(channelPendingRequests.id, pendingRequestId))
    .limit(1);
  if (!pending) return null;
  if (!pending.processedAt) return { status: "pending" };
  if (pending.processingErrorCode) return { errorCode: pending.processingErrorCode, status: "failed" };
  if (!pending.encryptedResult) return { errorCode: "missing_result", status: "failed" };
  return { result: decryptValue(pending.encryptedResult), status: "completed" };
}

export async function revokeChannelIdentity(
  db: AttentionDatabase,
  accountId: string,
  identityId: string,
  now = new Date(),
): Promise<boolean> {
  const [revoked] = await db
    .update(channelIdentities)
    .set({ revokedAt: now })
    .where(
      and(
        eq(channelIdentities.id, identityId),
        eq(channelIdentities.accountId, accountId),
        isNull(channelIdentities.revokedAt),
      ),
    )
    .returning({ id: channelIdentities.id });
  return Boolean(revoked);
}
