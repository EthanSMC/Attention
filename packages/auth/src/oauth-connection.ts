import {
  and,
  eq,
  isNull,
  oauthClients,
  oauthConnections,
  type AttentionDatabase,
  type AttentionTransaction,
} from "@attention/db";
import { CHANNEL_RUNTIME_RESOURCE } from "@attention/contracts";

export type OAuthConnectionIntent =
  | { mode: "auto" }
  | { mode: "create"; label: string }
  | { mode: "replace"; label: string; replacementConnectionId: string }
  | { mode: "rotate"; connectionId: string; label: string };

export type OAuthConnectionNameResult =
  | { status: "available"; label: string; normalizedLabel: string }
  | {
      status: "replaceable";
      label: string;
      normalizedLabel: string;
      existing: {
        connectionId: string;
        clientName: string;
        createdAt: Date;
        lastUsedAt: Date | null;
      };
    };

export class OAuthConnectionNameConflictError extends Error {
  constructor() {
    super("oauth_connection_name_conflict");
    this.name = "OAuthConnectionNameConflictError";
  }
}

export class OAuthConnectionNotFoundError extends Error {
  constructor() {
    super("oauth_connection_not_found");
    this.name = "OAuthConnectionNotFoundError";
  }
}

export function normalizeOAuthConnectionLabel(
  value: string,
): { label: string; normalizedLabel: string } {
  const label = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const normalizedLabel = label.toLowerCase();
  if (
    /[\p{Cc}\p{Cf}]/u.test(label) ||
    [...label].length < 1 ||
    [...label].length > 80 ||
    [...normalizedLabel].length > 80
  ) {
    throw new Error("invalid_connection_label");
  }
  return { label, normalizedLabel };
}

export function oauthConnectionLabelCandidate(
  baseLabel: string,
  ordinal: number,
): { label: string; normalizedLabel: string } {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("invalid_connection_label_ordinal");
  }
  const normalizedBase = baseLabel
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
  if (!normalizedBase || /[\p{Cc}\p{Cf}]/u.test(normalizedBase)) {
    throw new Error("invalid_connection_label");
  }

  const suffix = ordinal === 1 ? "" : ` ${ordinal}`;
  const suffixLength = [...suffix].length;
  const baseCodePoints = [...normalizedBase];
  for (
    let baseLength = Math.min(baseCodePoints.length, 80 - suffixLength);
    baseLength >= 1;
    baseLength -= 1
  ) {
    const candidate = `${baseCodePoints.slice(0, baseLength).join("").trimEnd()}${suffix}`;
    try {
      return normalizeOAuthConnectionLabel(candidate);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "invalid_connection_label") {
        throw error;
      }
    }
  }
  throw new Error("invalid_connection_label");
}

export async function checkOAuthConnectionName(
  db: AttentionDatabase,
  input: { accountId: string; audience: string; label: string },
): Promise<OAuthConnectionNameResult> {
  const normalized = normalizeOAuthConnectionLabel(input.label);
  const [existing] = await db
    .select({
      clientName: oauthClients.name,
      connectionId: oauthConnections.id,
      createdAt: oauthConnections.createdAt,
      lastUsedAt: oauthConnections.lastUsedAt,
    })
    .from(oauthConnections)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConnections.clientId))
    .where(
      and(
        eq(oauthConnections.accountId, input.accountId),
        eq(oauthConnections.audience, input.audience),
        eq(oauthConnections.normalizedLabel, normalized.normalizedLabel),
        isNull(oauthConnections.revokedAt),
      ),
    )
    .limit(1);
  if (!existing) return { status: "available", ...normalized };
  return {
    status: "replaceable",
    ...normalized,
    existing,
  };
}

export async function renameOAuthConnection(
  db: AttentionDatabase,
  input: { accountId: string; connectionId: string; label: string },
  now = new Date(),
): Promise<{ label: string; renamed: boolean }> {
  const normalized = normalizeOAuthConnectionLabel(input.label);
  try {
    return await db.transaction(async (tx) => {
      const [connection] = await tx
        .select({
          label: oauthConnections.label,
          normalizedLabel: oauthConnections.normalizedLabel,
        })
        .from(oauthConnections)
        .where(
          and(
            eq(oauthConnections.id, input.connectionId),
            eq(oauthConnections.accountId, input.accountId),
            isNull(oauthConnections.revokedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!connection) throw new OAuthConnectionNotFoundError();
      if (connection.normalizedLabel === normalized.normalizedLabel) {
        return { label: connection.label, renamed: false };
      }

      const [updated] = await tx
        .update(oauthConnections)
        .set({
          label: normalized.label,
          normalizedLabel: normalized.normalizedLabel,
          updatedAt: now,
        })
        .where(
          and(
            eq(oauthConnections.id, input.connectionId),
            eq(oauthConnections.accountId, input.accountId),
            isNull(oauthConnections.revokedAt),
          ),
        )
        .returning({ label: oauthConnections.label });
      if (!updated) throw new OAuthConnectionNotFoundError();
      return { label: updated.label, renamed: true };
    });
  } catch (error) {
    if (isOAuthConnectionNameConflict(error)) {
      throw new OAuthConnectionNameConflictError();
    }
    throw error;
  }
}

/**
 * Resolves Runtime identity exclusively from server-validated DCR metadata.
 * The dynamic OAuth client ID is only a pointer to that trusted metadata; it
 * never becomes the installation identity itself.
 */
export async function resolveRuntimeOAuthConnectionIntent(
  db: AttentionDatabase | AttentionTransaction,
  input: {
    accountId: string;
    audience: typeof CHANNEL_RUNTIME_RESOURCE;
    clientId: string;
    label: string;
    replacementConnectionId?: string;
  },
): Promise<OAuthConnectionIntent> {
  if (input.audience !== CHANNEL_RUNTIME_RESOURCE) {
    throw new Error("invalid_runtime_audience");
  }
  const normalized = normalizeOAuthConnectionLabel(input.label);
  const [trustedClient] = await db
    .select({
      connectionKind: oauthClients.connectionKind,
      deviceName: oauthClients.deviceName,
      installationKeyHash: oauthClients.installationKeyHash,
    })
    .from(oauthClients)
    .where(
      and(
        eq(oauthClients.clientId, input.clientId),
        eq(oauthClients.active, true),
        eq(oauthClients.connectionKind, "runtime"),
      ),
    )
    .limit(1);
  if (
    !trustedClient?.deviceName ||
    !trustedClient.installationKeyHash ||
    !/^[0-9a-f]{64}$/u.test(trustedClient.installationKeyHash)
  ) {
    throw new Error("invalid_runtime_client_metadata");
  }

  const [installationConnections, nameConnections] = await Promise.all([
    db
      .select({ id: oauthConnections.id })
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.accountId, input.accountId),
          eq(oauthConnections.audience, CHANNEL_RUNTIME_RESOURCE),
          eq(oauthConnections.kind, "runtime"),
          eq(
            oauthConnections.installationKeyHash,
            trustedClient.installationKeyHash,
          ),
          isNull(oauthConnections.revokedAt),
        ),
      )
      .limit(1),
    db
      .select({ id: oauthConnections.id })
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.accountId, input.accountId),
          eq(oauthConnections.audience, CHANNEL_RUNTIME_RESOURCE),
          eq(oauthConnections.normalizedLabel, normalized.normalizedLabel),
          isNull(oauthConnections.revokedAt),
        ),
      )
      .limit(1),
  ]);
  const installationConnection = installationConnections[0];
  const nameConnection = nameConnections[0];

  if (installationConnection) {
    if (
      (nameConnection && nameConnection.id !== installationConnection.id) ||
      (input.replacementConnectionId &&
        input.replacementConnectionId !== installationConnection.id)
    ) {
      throw new OAuthConnectionNameConflictError();
    }
    return {
      connectionId: installationConnection.id,
      label: normalized.label,
      mode: "rotate",
    };
  }

  if (nameConnection) {
    if (input.replacementConnectionId === nameConnection.id) {
      return {
        label: normalized.label,
        mode: "replace",
        replacementConnectionId: nameConnection.id,
      };
    }
    throw new OAuthConnectionNameConflictError();
  }
  if (input.replacementConnectionId) {
    throw new OAuthConnectionNameConflictError();
  }
  return { label: normalized.label, mode: "create" };
}

export function isOAuthConnectionNameConflict(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === "oauth_connections_active_name_unique" ||
        candidate.constraint === "oauth_connections_active_name_unique")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
