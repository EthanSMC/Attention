import "server-only";

import { apiKeyScopes } from "@attention/auth";
import {
  getAgentIntegration,
  type RuntimeCheckpointReport,
} from "@attention/contracts";
import {
  accounts,
  agentInstallations,
  and,
  apiCredentials,
  desc,
  eq,
  externalChannelBindings,
  filterProfiles,
  gt,
  isNull,
  oauthClients,
  oauthRefreshTokens,
  type AttentionDatabase,
} from "@attention/db";

export interface AccountOverview {
  avatarUrl: string | null;
  attentionId: string | null;
  attentionIdChangedAt: Date | null;
  displayName: string;
  email: string | null;
  hasPassword: boolean;
}

export async function loadAccountOverview(
  db: AttentionDatabase,
  accountId: string,
): Promise<AccountOverview | null> {
  const [row] = await db
    .select({
      avatarUrl: accounts.avatarUrl,
      attentionId: accounts.attentionId,
      attentionIdChangedAt: accounts.attentionIdChangedAt,
      displayName: accounts.displayName,
      email: accounts.primaryEmail,
      passwordHash: accounts.passwordHash,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row
    ? {
        avatarUrl: row.avatarUrl,
        attentionId: row.attentionId,
        attentionIdChangedAt: row.attentionIdChangedAt,
        displayName: row.displayName,
        email: row.email,
        hasPassword: row.passwordHash !== null,
      }
    : null;
}

const ATTENTION_ID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1_000;

export type AttentionIdErrorCode =
  | "account_not_found"
  | "attention_id_cooldown"
  | "attention_id_taken"
  | "invalid_attention_id";

export class AttentionIdError extends Error {
  readonly code: AttentionIdErrorCode;
  readonly nextChangeAt: Date | null;

  constructor(
    code: AttentionIdErrorCode,
    options: { nextChangeAt?: Date | null } = {},
  ) {
    super(code);
    this.name = "AttentionIdError";
    this.code = code;
    this.nextChangeAt = options.nextChangeAt ?? null;
  }
}

export interface UpdatedAttentionId {
  attentionId: string;
  changedAt: Date;
  nextChangeAt: Date;
}

export function normalizeAttentionId(value: string): string {
  const attentionId = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{5,19}$/u.test(attentionId)) {
    throw new AttentionIdError("invalid_attention_id");
  }
  return attentionId;
}

function nextAttentionIdChange(changedAt: Date): Date {
  return new Date(changedAt.getTime() + ATTENTION_ID_COOLDOWN_MS);
}

function isAttentionIdUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint === "accounts_attention_id_unique" ||
        candidate.constraint_name === "accounts_attention_id_unique")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export async function updateAttentionId(
  db: AttentionDatabase,
  accountId: string,
  value: string,
  now = new Date(),
): Promise<UpdatedAttentionId> {
  const attentionId = normalizeAttentionId(value);
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .select({
          attentionId: accounts.attentionId,
          attentionIdChangedAt: accounts.attentionIdChangedAt,
        })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.status, "active")))
        .for("update")
        .limit(1);
      if (!account) throw new AttentionIdError("account_not_found");

      if (account.attentionId === attentionId && account.attentionIdChangedAt) {
        return {
          attentionId,
          changedAt: account.attentionIdChangedAt,
          nextChangeAt: nextAttentionIdChange(account.attentionIdChangedAt),
        };
      }

      if (account.attentionId && account.attentionIdChangedAt) {
        const nextChangeAt = nextAttentionIdChange(account.attentionIdChangedAt);
        if (nextChangeAt > now) {
          throw new AttentionIdError("attention_id_cooldown", { nextChangeAt });
        }
      }

      const [updated] = await tx
        .update(accounts)
        .set({ attentionId, attentionIdChangedAt: now, updatedAt: now })
        .where(and(eq(accounts.id, accountId), eq(accounts.status, "active")))
        .returning({ attentionId: accounts.attentionId });
      if (!updated?.attentionId) throw new AttentionIdError("account_not_found");
      return {
        attentionId: updated.attentionId,
        changedAt: now,
        nextChangeAt: nextAttentionIdChange(now),
      };
    });
  } catch (error) {
    if (isAttentionIdUniqueViolation(error)) {
      throw new AttentionIdError("attention_id_taken");
    }
    throw error;
  }
}

const MAX_AVATAR_BYTES = 256 * 1024;

export interface AccountProfileUpdate {
  avatarUrl?: string | null;
  displayName?: string;
}

export interface UpdatedAccountProfile {
  avatarUrl: string | null;
  displayName: string;
}

function normalizeDisplayName(value: string): string {
  const displayName = value.normalize("NFKC").trim();
  const hasControlCharacter = Array.from(displayName).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (
    displayName.length < 1 ||
    displayName.length > 50 ||
    hasControlCharacter
  ) {
    throw new RangeError("invalid_display_name");
  }
  return displayName;
}

function normalizeAvatarUrl(value: string | null): string | null {
  if (value === null) return null;
  const match = /^data:image\/(webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match?.[1] || !match[2]) throw new RangeError("invalid_avatar_url");

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new RangeError("invalid_avatar_url");
  }
  const isJpeg =
    match[1] === "jpeg" &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    match[1] === "webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isWebp) throw new RangeError("invalid_avatar_url");
  return value;
}

export async function updateAccountProfile(
  db: AttentionDatabase,
  accountId: string,
  input: AccountProfileUpdate,
): Promise<UpdatedAccountProfile> {
  if (input.displayName === undefined && input.avatarUrl === undefined) {
    throw new RangeError("empty_profile_update");
  }

  const displayName =
    input.displayName === undefined
      ? undefined
      : normalizeDisplayName(input.displayName);
  const avatarUrl =
    input.avatarUrl === undefined
      ? undefined
      : normalizeAvatarUrl(input.avatarUrl);
  const updatedAt = new Date();

  return db.transaction(async (tx) => {
    const accountChanges: {
      avatarUrl?: string | null;
      displayName?: string;
      updatedAt: Date;
    } = { updatedAt };
    const publicProfileChanges: {
      avatarUrl?: string | null;
      displayName?: string;
      updatedAt: Date;
    } = { updatedAt };
    if (displayName !== undefined) {
      accountChanges.displayName = displayName;
      publicProfileChanges.displayName = displayName;
    }
    if (avatarUrl !== undefined) {
      accountChanges.avatarUrl = avatarUrl;
      publicProfileChanges.avatarUrl = avatarUrl;
    }

    const [updated] = await tx
      .update(accounts)
      .set(accountChanges)
      .where(eq(accounts.id, accountId))
      .returning({
        avatarUrl: accounts.avatarUrl,
        displayName: accounts.displayName,
      });
    if (!updated) throw new Error("account_not_found");

    await tx
      .update(filterProfiles)
      .set(publicProfileChanges)
      .where(eq(filterProfiles.accountId, accountId));
    return updated;
  });
}

export async function updateDisplayName(
  db: AttentionDatabase,
  accountId: string,
  value: string,
): Promise<string> {
  const updated = await updateAccountProfile(db, accountId, {
    displayName: value,
  });
  return updated.displayName;
}

export type LocalChannelRuntimeStatus =
  | "degraded"
  | "offline"
  | "online"
  | "stale";

export interface LocalChannelRuntimeOverview {
  deviceName: string;
  hostName: string;
  lastSeenAt: Date | null;
  lastSuccessfulMessageAt: Date | null;
  pendingInbound: number;
  pendingOutbound: number;
  status: LocalChannelRuntimeStatus;
}

interface LocalChannelRuntimeRow {
  agentIntegrationId: Parameters<typeof getAgentIntegration>[0];
  bindingLastSeenAt: Date | null;
  bindingStatus:
    | "disconnected"
    | "healthy"
    | "reported"
    | "revoked"
    | "stale"
    | "verified"
    | null;
  deviceName: string;
  installationId: string;
  installationLastSeenAt: Date | null;
  installationStatus:
    | "active"
    | "degraded"
    | "disconnected"
    | "registered"
    | "revoked"
    | "stale";
  runtimeCheckpoint: RuntimeCheckpointReport | null;
}

function latestDate(first: Date | null, second: Date | null): Date | null {
  if (!first) return second;
  if (!second) return first;
  return first > second ? first : second;
}

function localChannelRuntimeStatus(
  row: LocalChannelRuntimeRow,
): LocalChannelRuntimeStatus {
  const checkpoint = row.runtimeCheckpoint;
  if (
    row.installationStatus === "disconnected" ||
    row.installationStatus === "revoked" ||
    row.bindingStatus === "disconnected" ||
    row.bindingStatus === "revoked" ||
    checkpoint?.codex_phase === "stopped"
  ) {
    return "offline";
  }
  if (
    row.installationStatus === "stale" ||
    row.bindingStatus === "stale"
  ) {
    return "stale";
  }
  if (
    row.installationStatus === "active" &&
    row.bindingStatus === "healthy" &&
    checkpoint?.bridge_status === "online" &&
    checkpoint.ilink_status === "connected" &&
    checkpoint.codex_phase === "healthy"
  ) {
    return "online";
  }
  if (
    row.installationStatus === "degraded" ||
    checkpoint ||
    row.bindingStatus === "reported" ||
    row.bindingStatus === "verified"
  ) {
    return "degraded";
  }
  return "offline";
}

function projectLocalChannelRuntimes(
  rows: LocalChannelRuntimeRow[],
): LocalChannelRuntimeOverview[] {
  const seenInstallations = new Set<string>();
  const runtimes: LocalChannelRuntimeOverview[] = [];
  for (const row of rows) {
    if (seenInstallations.has(row.installationId)) continue;
    seenInstallations.add(row.installationId);
    const checkpoint = row.runtimeCheckpoint;
    runtimes.push({
      deviceName: row.deviceName,
      hostName: getAgentIntegration(row.agentIntegrationId).display_name,
      lastSeenAt: latestDate(
        row.installationLastSeenAt,
        row.bindingLastSeenAt,
      ),
      lastSuccessfulMessageAt: checkpoint?.last_successful_message_at
        ? new Date(checkpoint.last_successful_message_at)
        : null,
      pendingInbound: checkpoint?.pending_inbound ?? 0,
      pendingOutbound: checkpoint?.pending_outbound ?? 0,
      status: localChannelRuntimeStatus(row),
    });
  }
  return runtimes;
}

export async function loadConnectionOverview(db: AttentionDatabase, accountId: string) {
  const [oauth, pats, localChannelRuntimeRows] = await Promise.all([
    db
      .select({
        clientId: oauthRefreshTokens.clientId,
        clientName: oauthClients.name,
        createdAt: oauthRefreshTokens.createdAt,
        expiresAt: oauthRefreshTokens.expiresAt,
        id: oauthRefreshTokens.id,
        scopes: oauthRefreshTokens.scopes,
      })
      .from(oauthRefreshTokens)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthRefreshTokens.clientId))
      .where(
        and(
          eq(oauthRefreshTokens.accountId, accountId),
          eq(oauthRefreshTokens.status, "active"),
          isNull(oauthRefreshTokens.revokedAt),
          gt(oauthRefreshTokens.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(oauthRefreshTokens.createdAt)),
    db
      .select({
        createdAt: apiCredentials.createdAt,
        expiresAt: apiCredentials.expiresAt,
        id: apiCredentials.id,
        keyPrefix: apiCredentials.keyPrefix,
        lastUsedAt: apiCredentials.lastUsedAt,
        name: apiCredentials.name,
        scopes: apiCredentials.scopes,
        status: apiCredentials.status,
      })
      .from(apiCredentials)
      .where(eq(apiCredentials.accountId, accountId))
      .orderBy(desc(apiCredentials.createdAt)),
    db
      .select({
        agentIntegrationId: agentInstallations.agentIntegrationId,
        bindingLastSeenAt: externalChannelBindings.lastSeenAt,
        bindingStatus: externalChannelBindings.status,
        deviceName: agentInstallations.deviceName,
        installationId: agentInstallations.id,
        installationLastSeenAt: agentInstallations.lastSeenAt,
        installationStatus: agentInstallations.status,
        runtimeCheckpoint: agentInstallations.runtimeCheckpoint,
      })
      .from(agentInstallations)
      .leftJoin(
        externalChannelBindings,
        and(
          eq(externalChannelBindings.installationId, agentInstallations.id),
          eq(externalChannelBindings.accountId, accountId),
        ),
      )
      .where(eq(agentInstallations.accountId, accountId))
      .orderBy(
        desc(agentInstallations.registeredAt),
        desc(externalChannelBindings.updatedAt),
      ),
  ]);
  return {
    localChannelRuntimes: projectLocalChannelRuntimes(localChannelRuntimeRows),
    oauth,
    pats: pats.map((pat) => ({
      ...pat,
      needsRotation: apiKeyScopes.some((scope) => !pat.scopes.includes(scope)),
    })),
  };
}
