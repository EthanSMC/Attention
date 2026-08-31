import type { SessionPrincipal } from "@attention/auth";
import type { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({})),
  listAdminEntitlementAudits: vi.fn(),
}));

vi.mock("../../../../../../server/admin-user-entitlements", () => ({
  listAdminEntitlementAudits: mocks.listAdminEntitlementAudits,
}));
vi.mock("../../../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../../../server/session", () => ({
  clearInvalidSessionCookie: mocks.clearInvalidSessionCookie,
  getRequestSession: mocks.getRequestSession,
}));

import { GET } from "./route";

const originalAllowlist = process.env.ATTENTION_ADMIN_EMAILS;
const adminEmail = "admin@example.com";
const targetAccountId = "33333333-3333-4333-8333-333333333333";

function principal(primaryEmail: string): SessionPrincipal {
  return {
    accountId: "11111111-1111-4111-8111-111111111111",
    attentionId: "admin_01",
    authenticatedAt: new Date("2026-08-27T00:00:00.000Z"),
    displayName: "Admin",
    expiresAt: new Date("2026-09-27T00:00:00.000Z"),
    isFilter: false,
    isMember: true,
    primaryEmail,
    sessionId: "22222222-2222-4222-8222-222222222222",
    signupSource: "direct",
  };
}

function request(): NextRequest {
  return new Request(
    `https://attention.example/api/admin/users/${targetAccountId}/audits`,
  ) as NextRequest;
}

describe("admin user audits GET", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ATTENTION_ADMIN_EMAILS = adminEmail;
    mocks.getRequestSession.mockResolvedValue({
      principal: principal(adminEmail),
      shouldClearCookie: false,
    });
    mocks.listAdminEntitlementAudits.mockResolvedValue([
      {
        action: "set_member",
        actor: {
          accountId: "11111111-1111-4111-8111-111111111111",
          displayName: "Admin",
          primaryEmail: adminEmail,
        },
        id: "44444444-4444-4444-8444-444444444444",
        nextState: { isFilter: false, isMember: true, tier: "member" },
        occurredAt: new Date("2026-08-27T08:00:00.000Z"),
        previousState: { isFilter: false, isMember: false, tier: "free" },
        reason: "Approved",
        requestId: "request-1",
        source: "admin_console",
        targetAccountId,
      },
    ]);
  });

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.ATTENTION_ADMIN_EMAILS;
    else process.env.ATTENTION_ADMIN_EMAILS = originalAllowlist;
  });

  it("does not expose audits to a non-administrator", async () => {
    mocks.getRequestSession.mockResolvedValue({
      principal: principal("other@example.com"),
      shouldClearCookie: false,
    });

    const response = await GET(request(), {
      params: Promise.resolve({ accountId: targetAccountId }),
    });

    expect(response.status).toBe(403);
    expect(mocks.listAdminEntitlementAudits).not.toHaveBeenCalled();
  });

  it("returns structured audit history to an administrator", async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ accountId: targetAccountId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          action: "set_member",
          actor: { account_id: "11111111-1111-4111-8111-111111111111" },
          occurred_at: "2026-08-27T08:00:00.000Z",
          request_id: "request-1",
          target_account_id: targetAccountId,
        },
      ],
    });
  });
});
