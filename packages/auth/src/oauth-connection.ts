import {
  and,
  eq,
  isNull,
  oauthClients,
  oauthConnections,
  type AttentionDatabase,
} from "@attention/db";

export type OAuthConnectionIntent =
  | { mode: "create"; label: string }
  | { mode: "replace"; label: string; replacementConnectionId: string }
  | { mode: "rotate"; connectionId: string };

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
