import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  OAuthConnectionNameConflictError: class extends Error {},
  OAuthConnectionNotFoundError: class extends Error {},
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({ database: "web" })),
  revokeOAuthClientConnection: vi.fn(),
  revokeOAuthConnection: vi.fn(),
  renameOAuthConnection: vi.fn(),
}));

vi.mock("@attention/auth", () => ({
  OAuthConnectionNameConflictError: mocks.OAuthConnectionNameConflictError,
  OAuthConnectionNotFoundError: mocks.OAuthConnectionNotFoundError,
  renameOAuthConnection: mocks.renameOAuthConnection,
  revokeOAuthClientConnection: mocks.revokeOAuthClientConnection,
  revokeOAuthConnection: mocks.revokeOAuthConnection,
}));
vi.mock("../../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../../server/session", () => ({
  getRequestSession: mocks.getRequestSession,
}));

import { DELETE, PATCH } from "./route";

const connectionId = "10000000-0000-4000-8000-000000000001";

function request(method: "DELETE" | "PATCH" = "DELETE", body?: unknown): NextRequest {
  return new Request("https://attention.example/api/account/oauth/connection", {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: "https://attention.example",
      "sec-fetch-site": "same-origin",
    },
    method,
  }) as NextRequest;
}

describe("logical OAuth connection revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: { accountId: "account-1" },
      shouldClearCookie: false,
    });
  });

  it("revokes only the account-owned logical connection ID", async () => {
    const response = await DELETE(request(), {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.revokeOAuthConnection).toHaveBeenCalledWith(
      { database: "web" },
      "account-1",
      connectionId,
    );
    expect(mocks.revokeOAuthClientConnection).not.toHaveBeenCalled();
  });
});

describe("logical OAuth connection rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: { accountId: "account-1" },
      shouldClearCookie: false,
    });
    mocks.renameOAuthConnection.mockResolvedValue({
      label: "工作电脑",
      renamed: true,
    });
  });

  it("renames only the account-owned active connection", async () => {
    const response = await PATCH(request("PATCH", { label: " 工作电脑 " }), {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.renameOAuthConnection).toHaveBeenCalledWith(
      { database: "web" },
      {
        accountId: "account-1",
        connectionId,
        label: " 工作电脑 ",
      },
    );
    await expect(response.json()).resolves.toEqual({
      label: "工作电脑",
      renamed: true,
    });
  });

  it("returns a recoverable conflict without changing the submitted label", async () => {
    mocks.renameOAuthConnection.mockRejectedValueOnce(
      new mocks.OAuthConnectionNameConflictError(),
    );

    const response = await PATCH(request("PATCH", { label: "Codex" }), {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "oauth_connection_name_conflict" },
    });
  });

  it("uses the same non-disclosing response for missing or foreign connections", async () => {
    mocks.renameOAuthConnection.mockRejectedValueOnce(
      new mocks.OAuthConnectionNotFoundError(),
    );

    const response = await PATCH(request("PATCH", { label: "Codex" }), {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "oauth_connection_not_found" },
    });
  });

  it.each([
    ["an empty label", { label: "" }],
    ["an unknown property", { label: "Codex", audience: "attention-mcp" }],
  ])("rejects %s before calling the rename service", async (_case, body) => {
    const response = await PATCH(request("PATCH", body), {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(400);
    expect(mocks.renameOAuthConnection).not.toHaveBeenCalled();
  });
});
