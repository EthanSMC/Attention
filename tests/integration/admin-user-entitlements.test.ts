import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  changeAdminUserEntitlement,
  listAdminEntitlementAudits,
  listAdminUsers,
} from "../../apps/web/src/server/admin-user-entitlements";
import type { SessionPrincipal } from "@attention/auth";
import { resolveAccountCapabilities } from "@attention/auth";
import {
  accounts,
  adminEntitlementAudits,
  createDatabase,
  entitlements,
  eq,
  filterProfiles,
  membershipGrants,
  sessions,
  subscriptions,
  type DatabaseHandle,
} from "@attention/db";

const databaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
const adminAccountId = "10000000-0000-4000-8000-000000000001";
const freeAccountId = "10000000-0000-4000-8000-000000000002";
const memberAccountId = "10000000-0000-4000-8000-000000000003";
const filterAccountId = "10000000-0000-4000-8000-000000000004";
const adminEmail = "local-admin@example.com";

function principal(): SessionPrincipal {
  return {
    accountId: adminAccountId,
    attentionId: "admin_01",
    authenticatedAt: new Date("2026-08-27T00:00:00.000Z"),
    displayName: "Local Admin",
    expiresAt: new Date("2026-09-27T00:00:00.000Z"),
    isFilter: false,
    isMember: true,
    primaryEmail: adminEmail,
    sessionId: "20000000-0000-4000-8000-000000000001",
    signupSource: "direct",
  };
}

describe.skipIf(!databaseUrl)("admin user entitlement service", () => {
  let handle: DatabaseHandle;
  const originalAllowlist = process.env.ATTENTION_ADMIN_EMAILS;
  const now = new Date("2026-08-27T08:00:00.000Z");

  beforeAll(() => {
    process.env.ATTENTION_ADMIN_EMAILS = adminEmail;
    handle = createDatabase(databaseUrl!, { maxConnections: 4 });
  });

  afterAll(async () => {
    if (originalAllowlist === undefined) delete process.env.ATTENTION_ADMIN_EMAILS;
    else process.env.ATTENTION_ADMIN_EMAILS = originalAllowlist;
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.delete(adminEntitlementAudits);
    await handle.db.delete(sessions);
    await handle.db.delete(filterProfiles);
    await handle.db.delete(entitlements);
    await handle.db.delete(membershipGrants);
    await handle.db.delete(subscriptions);
    await handle.db.delete(accounts);

    await handle.db.insert(accounts).values([
      {
        attentionId: "admin_01",
        attentionIdChangedAt: now,
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        displayName: "Local Admin",
        emailVerifiedAt: now,
        id: adminAccountId,
        primaryEmail: adminEmail,
        stableHandle: "local-admin",
        status: "active",
        updatedAt: now,
      },
      {
        attentionId: "free_001",
        attentionIdChangedAt: now,
        createdAt: new Date("2026-08-21T00:00:00.000Z"),
        displayName: "Free Reader",
        emailVerifiedAt: now,
        id: freeAccountId,
        primaryEmail: "reader@example.com",
        stableHandle: "free-reader",
        status: "active",
        updatedAt: now,
      },
      {
        attentionId: "member_1",
        attentionIdChangedAt: now,
        createdAt: new Date("2026-08-22T00:00:00.000Z"),
        displayName: "Member Person",
        emailVerifiedAt: now,
        id: memberAccountId,
        primaryEmail: "member@example.com",
        stableHandle: "member-person",
        status: "active",
        updatedAt: now,
      },
      {
        attentionId: "filter_1",
        attentionIdChangedAt: now,
        createdAt: new Date("2026-08-23T00:00:00.000Z"),
        displayName: "Filter Curator",
        emailVerifiedAt: now,
        id: filterAccountId,
        primaryEmail: "curator@example.com",
        stableHandle: "filter-curator",
        status: "active",
        updatedAt: now,
      },
    ]);
    await handle.db.insert(entitlements).values([
      {
        accountId: adminAccountId,
        createdAt: now,
        memberEnabled: true,
        source: "signup",
        startsAt: now,
        updatedAt: now,
      },
      {
        accountId: memberAccountId,
        createdAt: now,
        memberEnabled: true,
        source: "signup",
        startsAt: now,
        updatedAt: now,
      },
      {
        accountId: filterAccountId,
        createdAt: now,
        memberEnabled: true,
        source: "filter_grant",
        startsAt: now,
        updatedAt: now,
      },
    ]);
    await handle.db.insert(filterProfiles).values({
      accountId: filterAccountId,
      active: true,
      displayName: "Filter Curator",
      invitedAt: now,
      updatedAt: now,
    });
  });

  it("searches email, display name, Attention ID, and live tier with pagination", async () => {
    await expect(
      listAdminUsers(handle.db, principal(), {
        now: new Date(now.getTime() + 1_000),
        page: 1,
        pageSize: 10,
        query: "READER@EXAMPLE",
      }),
    ).resolves.toMatchObject({
      items: [{ accountId: freeAccountId, tier: "free" }],
      total: 1,
    });
    await expect(
      listAdminUsers(handle.db, principal(), {
        now: new Date(now.getTime() + 1_000),
        page: 1,
        pageSize: 10,
        query: "Member Person",
      }),
    ).resolves.toMatchObject({
      items: [{ accountId: memberAccountId, tier: "member" }],
      total: 1,
    });
    await expect(
      listAdminUsers(handle.db, principal(), {
        now: new Date(now.getTime() + 1_000),
        page: 1,
        pageSize: 10,
        query: "filter_1",
      }),
    ).resolves.toMatchObject({
      items: [{ accountId: filterAccountId, tier: "filter" }],
      total: 1,
    });

    const members = await listAdminUsers(handle.db, principal(), {
      now: new Date(now.getTime() + 1_000),
      page: 1,
      pageSize: 1,
      tier: "member",
    });
    expect(members.items).toHaveLength(1);
    expect(members.total).toBe(2);
    expect(members.totalPages).toBe(2);
  });

  it("applies all three transitions atomically and exposes their audit history", async () => {
    const filterResult = await changeAdminUserEntitlement(handle.db, principal(), {
      action: "set_filter",
      now,
      reason: "Approved for source curation",
      requestId: "admin-request-1",
      source: "admin_console",
      targetAccountId: freeAccountId,
    });
    expect(filterResult).toMatchObject({
      nextState: { isFilter: true, isMember: true, tier: "filter" },
      previousState: { isFilter: false, isMember: false, tier: "free" },
    });
    await expect(
      resolveAccountCapabilities(handle.db, freeAccountId, new Date(now.getTime() + 1)),
    ).resolves.toEqual({ isFilter: true, isMember: true });

    const revoked = await changeAdminUserEntitlement(handle.db, principal(), {
      action: "revoke_filter",
      now: new Date(now.getTime() + 1_000),
      reason: "Curation access no longer needed",
      requestId: "admin-request-2",
      source: "admin_console",
      targetAccountId: freeAccountId,
    });
    expect(revoked.nextState).toEqual({
      isFilter: false,
      isMember: true,
      tier: "member",
    });

    const member = await changeAdminUserEntitlement(handle.db, principal(), {
      action: "set_member",
      now: new Date(now.getTime() + 2_000),
      reason: "Keep Member while removing Filter",
      requestId: "admin-request-3",
      source: "admin_console",
      targetAccountId: filterAccountId,
    });
    expect(member.nextState).toEqual({
      isFilter: false,
      isMember: true,
      tier: "member",
    });

    const audits = await listAdminEntitlementAudits(
      handle.db,
      principal(),
      freeAccountId,
      10,
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: "revoke_filter",
      actor: { accountId: adminAccountId, primaryEmail: adminEmail },
      reason: "Curation access no longer needed",
      requestId: "admin-request-2",
      source: "admin_console",
      targetAccountId: freeAccountId,
    });
    expect(
      await handle.db
        .select({ active: filterProfiles.active, revokedAt: filterProfiles.revokedAt })
        .from(filterProfiles)
        .where(eq(filterProfiles.accountId, filterAccountId)),
    ).toEqual([{ active: false, revokedAt: new Date(now.getTime() + 2_000) }]);
  });
});
