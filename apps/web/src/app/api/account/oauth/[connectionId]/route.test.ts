import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({ database: "web" })),
  revokeOAuthClientConnection: vi.fn(),
  revokeOAuthConnection: vi.fn(),
}));

vi.mock("@attention/auth", () => ({
  revokeOAuthClientConnection: mocks.revokeOAuthClientConnection,
  revokeOAuthConnection: mocks.revokeOAuthConnection,
}));
vi.mock("../../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../../server/session", () => ({
  getRequestSession: mocks.getRequestSession,
}));

import { DELETE } from "./route";

const connectionId = "10000000-0000-4000-8000-000000000001";

function request(): NextRequest {
  return new Request("https://attention.example/api/account/oauth/connection", {
    headers: {
      origin: "https://attention.example",
      "sec-fetch-site": "same-origin",
    },
    method: "DELETE",
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
