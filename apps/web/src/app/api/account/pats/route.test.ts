import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiCredential: vi.fn(),
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({})),
}));

vi.mock("@attention/auth", () => ({
  createApiCredential: mocks.createApiCredential,
}));
vi.mock("../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../server/session", () => ({
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: mocks.getRequestSession,
}));

import { POST } from "./route";

describe("API Key creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: {
        accountId: "account-free",
        isFilter: false,
        isMember: false,
      },
      shouldClearCookie: false,
    });
    mocks.createApiCredential.mockResolvedValue({
      credentialId: "credential-1",
      expiresAt: new Date("2026-11-03T00:00:00.000Z"),
      key: "att_pat_secret",
      keyPrefix: "att_pat_secret",
      name: "Attention API Key",
    });
  });

  it("creates the same account-bound Key for a Free account without client scopes", async () => {
    const response = await POST(
      new Request("https://attention.example/api/account/pats", {
        body: JSON.stringify({
          expires_in_days: 90,
          name: "Attention API Key",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }) as NextRequest,
    );

    expect(response.status).toBe(201);
    expect(mocks.createApiCredential).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        accountId: "account-free",
        name: "Attention API Key",
      }),
    );
    expect(mocks.createApiCredential.mock.calls[0]?.[1]).not.toHaveProperty("scopes");
    await expect(response.json()).resolves.not.toHaveProperty("scopes");
  });

  it("rejects the old client-selected scope shape", async () => {
    const response = await POST(
      new Request("https://attention.example/api/account/pats", {
        body: JSON.stringify({
          expires_in_days: 90,
          name: "Legacy advanced Key",
          scopes: ["ai:search"],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }) as NextRequest,
    );

    expect(response.status).toBe(400);
    expect(mocks.createApiCredential).not.toHaveBeenCalled();
  });
});
