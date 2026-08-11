import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  OAuthConnectionSnapshotConflictError: class extends Error {},
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({ database: "web" })),
  revokeMcpOAuthConnectionSnapshot: vi.fn(),
}));

vi.mock("@attention/auth", () => ({
  OAuthConnectionSnapshotConflictError:
    mocks.OAuthConnectionSnapshotConflictError,
  revokeMcpOAuthConnectionSnapshot: mocks.revokeMcpOAuthConnectionSnapshot,
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
    mocks.revokeMcpOAuthConnectionSnapshot.mockResolvedValue(3);
  });

  it("server-fixes account and MCP audience while revoking the exact confirmed snapshot", async () => {
    const route = await import("./route").catch(() => null);
    expect(route).not.toBeNull();
    if (!route) return;

    const connectionIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
    ];
    const response = await route.DELETE(request({
      client_name: "  Codex  ",
      connection_ids: connectionIds,
    }));

    expect(response.status).toBe(200);
    expect(mocks.revokeMcpOAuthConnectionSnapshot).toHaveBeenCalledWith(
      { database: "web" },
      {
        accountId: "account-1",
        clientName: "  Codex  ",
        connectionIds,
      },
    );
    await expect(response.json()).resolves.toEqual({ revoked_count: 3 });
  });

  it("returns a recoverable conflict when the confirmed connection snapshot is stale", async () => {
    mocks.revokeMcpOAuthConnectionSnapshot.mockRejectedValueOnce(
      new mocks.OAuthConnectionSnapshotConflictError(),
    );
    const route = await import("./route");

    const response = await route.DELETE(request({
      client_name: "Codex",
      connection_ids: ["10000000-0000-4000-8000-000000000001"],
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "oauth_connection_snapshot_stale",
        message: "连接列表已变化，请刷新后重试。",
      },
    });
  });

  it.each([
    {
      account_id: "account-2",
      client_name: "Codex",
      connection_ids: ["10000000-0000-4000-8000-000000000001"],
    },
    {
      audience: "attention-channel-runtime",
      client_name: "Codex",
      connection_ids: ["10000000-0000-4000-8000-000000000001"],
    },
  ])("rejects caller-selected ownership or audience fields", async (body) => {
    const route = await import("./route").catch(() => null);
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.DELETE(request(body));

    expect(response.status).toBe(400);
    expect(mocks.revokeMcpOAuthConnectionSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      "duplicate IDs",
      [
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000001",
      ],
    ],
    [
      "an oversized snapshot",
      Array.from(
        { length: 101 },
        (_, index) =>
          `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ),
    ],
  ])("rejects %s before starting a transaction", async (_case, connectionIds) => {
    const route = await import("./route");

    const response = await route.DELETE(request({
      client_name: "Codex",
      connection_ids: connectionIds,
    }));

    expect(response.status).toBe(400);
    expect(mocks.revokeMcpOAuthConnectionSnapshot).not.toHaveBeenCalled();
  });
});
