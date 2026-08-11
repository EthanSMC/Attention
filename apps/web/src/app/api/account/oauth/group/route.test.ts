import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({ database: "web" })),
  revokeMcpOAuthConnectionGroup: vi.fn(),
}));

vi.mock("../../../../../server/account", () => ({
  revokeMcpOAuthConnectionGroup: mocks.revokeMcpOAuthConnectionGroup,
}));
vi.mock("../../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../../server/session", () => ({
  getRequestSession: mocks.getRequestSession,
}));

function request(body: unknown): NextRequest {
  return new Request("https://attention.example/api/account/oauth/group", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://attention.example",
      "sec-fetch-site": "same-origin",
    },
    method: "DELETE",
  }) as NextRequest;
}

describe("MCP OAuth connection group revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: { accountId: "account-1" },
      shouldClearCookie: false,
    });
    mocks.revokeMcpOAuthConnectionGroup.mockResolvedValue(3);
  });

  it("server-fixes account and MCP audience while revoking the normalized client group", async () => {
    const route = await import("./route").catch(() => null);
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.DELETE(request({ client_name: "  Codex  " }));

    expect(response.status).toBe(200);
    expect(mocks.revokeMcpOAuthConnectionGroup).toHaveBeenCalledWith(
      { database: "web" },
      { accountId: "account-1", clientName: "  Codex  " },
    );
    await expect(response.json()).resolves.toEqual({ revoked_count: 3 });
  });

  it.each([
    { account_id: "account-2", client_name: "Codex" },
    { audience: "attention-channel-runtime", client_name: "Codex" },
  ])("rejects caller-selected ownership or audience fields", async (body) => {
    const route = await import("./route").catch(() => null);
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.DELETE(request(body));

    expect(response.status).toBe(400);
    expect(mocks.revokeMcpOAuthConnectionGroup).not.toHaveBeenCalled();
  });
});
