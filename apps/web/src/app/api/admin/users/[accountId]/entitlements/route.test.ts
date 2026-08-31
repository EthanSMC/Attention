import type { SessionPrincipal } from "@attention/auth";
import type { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changeAdminUserEntitlement: vi.fn(),
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({})),
}));

vi.mock("../../../../../../server/admin-user-entitlements", () => ({
  changeAdminUserEntitlement: mocks.changeAdminUserEntitlement,
}));
vi.mock("../../../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../../../server/session", () => ({
  clearInvalidSessionCookie: mocks.clearInvalidSessionCookie,
  getRequestSession: mocks.getRequestSession,
}));

import { POST } from "./route";

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

function request(
  body: unknown,
  requestId = "browser-request-1",
): NextRequest {
  const source = JSON.stringify(body);
  return new Request(
    `https://attention.example/api/admin/users/${targetAccountId}/entitlements`,
    {
      body: source,
      headers: {
        "content-length": String(Buffer.byteLength(source)),
        "content-type": "application/json",
        origin: "https://attention.example",
        "sec-fetch-site": "same-origin",
        "x-request-id": requestId,
      },
      method: "POST",
    },
  ) as NextRequest;
}

describe("admin user entitlement POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ATTENTION_ADMIN_EMAILS = adminEmail;
    mocks.getRequestSession.mockResolvedValue({
      principal: principal(adminEmail),
      shouldClearCookie: false,
    });
    mocks.changeAdminUserEntitlement.mockResolvedValue({
      action: "set_filter",
      auditId: "44444444-4444-4444-8444-444444444444",
      nextState: { isFilter: true, isMember: true, tier: "filter" },
      previousState: { isFilter: false, isMember: true, tier: "member" },
      targetAccountId,
    });
  });

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.ATTENTION_ADMIN_EMAILS;
    else process.env.ATTENTION_ADMIN_EMAILS = originalAllowlist;
  });

  it("returns 403 before parsing or mutating for a non-administrator", async () => {
    mocks.getRequestSession.mockResolvedValue({
      principal: principal("other@example.com"),
      shouldClearCookie: false,
    });

    const response = await POST(request({ unexpected: true }), {
      params: Promise.resolve({ accountId: targetAccountId }),
    });

    expect(response.status).toBe(403);
    expect(mocks.changeAdminUserEntitlement).not.toHaveBeenCalled();
  });

  it.each([
    { action: "set_filter", confirmed: false, reason: "Approved" },
    { action: "set_filter", confirmed: true, reason: "no" },
    { action: "make_admin", confirmed: true, reason: "Approved" },
  ])("rejects an unconfirmed or invalid mutation: %o", async (body) => {
    const response = await POST(request(body), {
      params: Promise.resolve({ accountId: targetAccountId }),
    });

    expect(response.status).toBe(400);
    expect(mocks.changeAdminUserEntitlement).not.toHaveBeenCalled();
  });

  it("requires a reason and explicit confirmation and preserves request correlation", async () => {
    const response = await POST(
      request({
        action: "set_filter",
        confirmed: true,
        reason: "Approved for curation",
      }),
      { params: Promise.resolve({ accountId: targetAccountId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("browser-request-1");
    expect(mocks.changeAdminUserEntitlement).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ primaryEmail: adminEmail }),
      {
        action: "set_filter",
        reason: "Approved for curation",
        requestId: "browser-request-1",
        source: "admin_console",
        targetAccountId,
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      action: "set_filter",
      audit_id: "44444444-4444-4444-8444-444444444444",
      next_state: { tier: "filter" },
    });
  });

  it("replaces an unsafe incoming request ID rather than reflecting it", async () => {
    const response = await POST(
      request(
        { action: "set_filter", confirmed: true, reason: "Approved" },
        "unsafe request id",
      ),
      { params: Promise.resolve({ accountId: targetAccountId }) },
    );

    const generated = response.headers.get("x-request-id");
    expect(generated).toMatch(/^[0-9a-f-]{36}$/u);
    expect(generated).not.toBe("unsafe request id");
  });
});
