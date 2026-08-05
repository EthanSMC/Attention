import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectInvitation: vi.fn(),
}));

vi.mock("@attention/auth", () => ({
  inspectInvitation: mocks.inspectInvitation,
  InvitationError: class InvitationError extends Error {
    code = "invalid_invitation";
  },
  redeemInvitation: vi.fn(),
}));
vi.mock("../../../server/db", () => ({
  getWebDatabase: vi.fn(() => ({})),
}));
vi.mock("../../../server/session", () => ({
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: vi.fn(),
  setSessionCookie: vi.fn(),
}));

import { GET } from "./route";

describe("invitation public identity presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not reveal the invited account's internal stable handle", async () => {
    mocks.inspectInvitation.mockResolvedValue({
      accountId: "account-1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      invitationId: "invitation-1",
      kind: "filter",
      stableHandle: "internal-secret-handle",
    });
    const request = new Request(
      "https://attention.example/invite/invitation-token",
    ) as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({ token: "invitation-token" }),
    });
    const html = await response.text();

    expect(html).toContain("确认后将以 Filter 身份登录");
    expect(html).not.toContain("internal-secret-handle");
    expect(html).not.toContain("稳定网名");
  });
});
