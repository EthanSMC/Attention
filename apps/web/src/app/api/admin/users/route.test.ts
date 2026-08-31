import type { SessionPrincipal } from "@attention/auth";
import type { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({})),
  listAdminUsers: vi.fn(),
}));

vi.mock("../../../../server/admin-user-entitlements", () => ({
  listAdminUsers: mocks.listAdminUsers,
  parseAdminUserListInput: (input: Record<string, unknown>) => {
    const page = input.page === undefined ? 1 : Number(input.page);
    const pageSize = input.pageSize === undefined ? 25 : Number(input.pageSize);
    if (!Number.isInteger(page) || page < 1) throw new Error("invalid_page");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error("invalid_page_size");
    }
    return {
      page,
      pageSize,
      ...(typeof input.query === "string" ? { query: input.query } : {}),
      ...(typeof input.tier === "string" ? { tier: input.tier } : {}),
    };
  },
}));
vi.mock("../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../server/session", () => ({
  clearInvalidSessionCookie: mocks.clearInvalidSessionCookie,
  getRequestSession: mocks.getRequestSession,
}));

import { GET } from "./route";

const originalAllowlist = process.env.ATTENTION_ADMIN_EMAILS;
const adminEmail = "admin@example.com";

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

function request(query = ""): NextRequest {
  return new Request(`https://attention.example/api/admin/users${query}`) as NextRequest;
}

describe("admin users GET", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ATTENTION_ADMIN_EMAILS = adminEmail;
    mocks.getRequestSession.mockResolvedValue({
      principal: principal(adminEmail),
      shouldClearCookie: false,
    });
    mocks.listAdminUsers.mockResolvedValue({
      items: [
        {
          accountId: "33333333-3333-4333-8333-333333333333",
          attentionId: "member_1",
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          displayName: "Member",
          isFilter: false,
          isMember: true,
          primaryEmail: "member@example.com",
          status: "active",
          tier: "member",
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
  });

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.ATTENTION_ADMIN_EMAILS;
    else process.env.ATTENTION_ADMIN_EMAILS = originalAllowlist;
  });

  it("returns 401 and clears an invalid unauthenticated session", async () => {
    mocks.getRequestSession.mockResolvedValue({
      principal: null,
      shouldClearCookie: true,
    });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.clearInvalidSessionCookie).toHaveBeenCalled();
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
  });

  it("returns 403 before querying for a non-allowlisted account", async () => {
    mocks.getRequestSession.mockResolvedValue({
      principal: principal("other@example.com"),
      shouldClearCookie: false,
    });

    const response = await GET(request("?q=member"));

    expect(response.status).toBe(403);
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
  });

  it("returns a no-store server-paginated result for an administrator", async () => {
    const response = await GET(request("?q=member&tier=member&page=1&page_size=25"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          account_id: "33333333-3333-4333-8333-333333333333",
          created_at: "2026-08-20T00:00:00.000Z",
          tier: "member",
        },
      ],
      pagination: { page: 1, page_size: 25, total: 1, total_pages: 1 },
    });
    expect(mocks.listAdminUsers).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ primaryEmail: adminEmail }),
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        query: "member",
        tier: "member",
      }),
    );
  });

  it("rejects invalid pagination without querying users", async () => {
    const response = await GET(request("?page=0"));

    expect(response.status).toBe(400);
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
  });
});
