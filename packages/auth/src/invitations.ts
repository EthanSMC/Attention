import {
  accounts,
  and,
  type AttentionDatabase,
  eq,
  entitlements,
  filterProfiles,
  invitations,
  sessions
} from "@attention/db";

import { defaultSessionTtlSeconds, type IssuedSession } from "./sessions";
import { createOpaqueToken, hashOpaqueToken } from "./tokens";

const defaultInvitationTtlSeconds = 7 * 24 * 60 * 60;

export type InvitationErrorCode =
  | "account_not_found"
  | "account_not_redeemable"
  | "invalid_invitation"
  | "invitation_already_consumed"
  | "invitation_expired"
  | "stable_handle_required"
  | "invalid_stable_handle";

export class InvitationError extends Error {
  readonly code: InvitationErrorCode;

  constructor(code: InvitationErrorCode) {
    super(code);
    this.name = "InvitationError";
    this.code = code;
  }
}

export interface CreateInvitationInput {
  kind: "member" | "filter";
  stableHandle?: string;
  accountId?: string;
  filterDisplayName?: string;
  createdByAccountId?: string;
  now?: Date;
  expiresAt?: Date;
}

export interface CreatedInvitation {
  invitationId: string;
  accountId: string;
  token: string;
  expiresAt: Date;
  kind: "member" | "filter";
}

export interface RedeemedInvitation {
  invitationId: string;
  accountId: string;
  kind: "member" | "filter";
  session: IssuedSession;
}

export interface InvitationPreview {
  invitationId: string;
  accountId: string;
  kind: "member" | "filter";
  expiresAt: Date;
}

export function normalizeStableHandle(value: string): string {
  const handle = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (
    handle.length < 3 ||
    handle.length > 64 ||
    !/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])$/u.test(handle)
  ) {
    throw new InvitationError("invalid_stable_handle");
  }
  return handle;
}

export async function createInvitation(
  db: AttentionDatabase,
  input: CreateInvitationInput
): Promise<CreatedInvitation> {
  const now = input.now ?? new Date();
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + defaultInvitationTtlSeconds * 1_000);
  if (expiresAt <= now) {
    throw new RangeError("Invitation expiry must be in the future");
  }
  if (!input.accountId && !input.stableHandle) {
    throw new InvitationError("stable_handle_required");
  }

  const token = createOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);

  return db.transaction(async (tx) => {
    let accountId = input.accountId;
    if (accountId) {
      const [account] = await tx
        .select({ id: accounts.id, status: accounts.status })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (!account) {
        throw new InvitationError("account_not_found");
      }
      if (account.status === "deleted" || account.status === "suspended") {
        throw new InvitationError("account_not_redeemable");
      }
    } else {
      const stableHandle = normalizeStableHandle(input.stableHandle!);
      const [account] = await tx
        .insert(accounts)
        .values({ stableHandle, status: "invited", createdAt: now, updatedAt: now })
        .returning({ id: accounts.id });
      if (!account) {
        throw new Error("Failed to create invited account");
      }
      accountId = account.id;
    }

    const invitationValues: typeof invitations.$inferInsert = {
      accountId,
      kind: input.kind,
      tokenHash,
      expiresAt,
      createdAt: now
    };
    if (input.createdByAccountId) {
      invitationValues.createdByAccountId = input.createdByAccountId;
    }
    if (input.filterDisplayName) {
      invitationValues.filterDisplayName = input.filterDisplayName;
    }

    const [invitation] = await tx
      .insert(invitations)
      .values(invitationValues)
      .returning({ id: invitations.id });
    if (!invitation) {
      throw new Error("Failed to create invitation");
    }

    return { invitationId: invitation.id, accountId, token, expiresAt, kind: input.kind };
  });
}

export async function inspectInvitation(
  db: AttentionDatabase,
  token: string,
  options: { now?: Date } = {}
): Promise<InvitationPreview> {
  let tokenHash: string;
  try {
    tokenHash = await hashOpaqueToken(token);
  } catch {
    throw new InvitationError("invalid_invitation");
  }

  const now = options.now ?? new Date();
  const [invitation] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);
  if (!invitation) throw new InvitationError("invalid_invitation");
  if (invitation.consumedAt) {
    throw new InvitationError("invitation_already_consumed");
  }
  if (invitation.expiresAt <= now) {
    throw new InvitationError("invitation_expired");
  }

  const [account] = await db
    .select({
      id: accounts.id,
      status: accounts.status
    })
    .from(accounts)
    .where(eq(accounts.id, invitation.accountId))
    .limit(1);
  if (!account) throw new InvitationError("account_not_found");
  if (account.status === "deleted" || account.status === "suspended") {
    throw new InvitationError("account_not_redeemable");
  }

  return {
    invitationId: invitation.id,
    accountId: account.id,
    kind: invitation.kind,
    expiresAt: invitation.expiresAt
  };
}

export async function redeemInvitation(
  db: AttentionDatabase,
  token: string,
  options: { now?: Date; sessionTtlSeconds?: number } = {}
): Promise<RedeemedInvitation> {
  let tokenHash: string;
  try {
    tokenHash = await hashOpaqueToken(token);
  } catch {
    throw new InvitationError("invalid_invitation");
  }

  const now = options.now ?? new Date();
  const sessionTtlSeconds = options.sessionTtlSeconds ?? defaultSessionTtlSeconds;
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new RangeError("sessionTtlSeconds must be a positive integer");
  }

  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .for("update")
      .limit(1);
    if (!invitation) {
      throw new InvitationError("invalid_invitation");
    }
    if (invitation.consumedAt) {
      throw new InvitationError("invitation_already_consumed");
    }
    if (invitation.expiresAt <= now) {
      throw new InvitationError("invitation_expired");
    }

    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, invitation.accountId))
      .for("update")
      .limit(1);
    if (!account) {
      throw new InvitationError("account_not_found");
    }
    if (account.status === "deleted" || account.status === "suspended") {
      throw new InvitationError("account_not_redeemable");
    }

    await tx
      .update(accounts)
      .set({ status: "active", updatedAt: now })
      .where(eq(accounts.id, account.id));

    if (invitation.kind === "filter") {
      await tx
        .insert(filterProfiles)
        .values({
          accountId: account.id,
          displayName: invitation.filterDisplayName ?? account.displayName,
          active: true,
          invitedAt: now,
          revokedAt: null,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: filterProfiles.accountId,
          set: {
            displayName: invitation.filterDisplayName ?? account.displayName,
            active: true,
            invitedAt: now,
            revokedAt: null,
            updatedAt: now
          }
        });
    }

    const entitlementSource = invitation.kind === "filter" ? "filter_grant" : "invite";
    await tx
      .insert(entitlements)
      .values({
        accountId: account.id,
        memberEnabled: true,
        source: entitlementSource,
        startsAt: now,
        endsAt: null,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [entitlements.accountId, entitlements.source],
        set: { memberEnabled: true, startsAt: now, endsAt: null, updatedAt: now }
      });

    const [consumed] = await tx
      .update(invitations)
      .set({ consumedAt: now, consumedByAccountId: account.id })
      .where(and(eq(invitations.id, invitation.id), eq(invitations.accountId, account.id)))
      .returning({ id: invitations.id });
    if (!consumed) {
      throw new Error("Failed to consume invitation");
    }

    const sessionToken = createOpaqueToken();
    const sessionExpiresAt = new Date(now.getTime() + sessionTtlSeconds * 1_000);
    const [session] = await tx
      .insert(sessions)
      .values({
        accountId: account.id,
        tokenHash: await hashOpaqueToken(sessionToken),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: sessionExpiresAt
      })
      .returning({ id: sessions.id });
    if (!session) {
      throw new Error("Failed to create invitation session");
    }

    return {
      invitationId: invitation.id,
      accountId: account.id,
      kind: invitation.kind,
      session: {
        token: sessionToken,
        sessionId: session.id,
        accountId: account.id,
        expiresAt: sessionExpiresAt
      }
    };
  });
}
