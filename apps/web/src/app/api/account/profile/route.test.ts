import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({})),
  updateAccountProfile: vi.fn(),
}));

vi.mock("../../../../server/account", () => ({
  updateAccountProfile: mocks.updateAccountProfile,
}));
vi.mock("../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../server/session", () => ({
  clearInvalidSessionCookie: mocks.clearInvalidSessionCookie,
  getRequestSession: mocks.getRequestSession,
}));

import { PATCH } from "./route";

function profileRequest(body: unknown): NextRequest {
  const source = JSON.stringify(body);
  return new Request("https://attention.example/api/account/profile", {
    body: source,
    headers: {
      "content-length": String(Buffer.byteLength(source)),
      "content-type": "application/json",
      origin: "https://attention.example",
      "sec-fetch-site": "same-origin",
    },
    method: "PATCH",
  }) as NextRequest;
}

describe("account profile PATCH", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: { accountId: "account-1" },
      shouldClearCookie: false,
    });
    mocks.updateAccountProfile.mockImplementation(
      async (_db: unknown, _accountId: string, input: {
        avatarUrl?: string | null;
        displayName?: string;
      }) => ({
        avatarUrl: input.avatarUrl ?? null,
        displayName: input.displayName ?? "Lin",
      }),
    );
  });

  it("requires an authenticated browser session", async () => {
    mocks.getRequestSession.mockResolvedValue({
      principal: null,
      shouldClearCookie: true,
    });
    const response = await PATCH(profileRequest({ display_name: "Lin" }));

    expect(response.status).toBe(401);
    expect(mocks.clearInvalidSessionCookie).toHaveBeenCalled();
    expect(mocks.updateAccountProfile).not.toHaveBeenCalled();
  });

  it("accepts an avatar request larger than the global 40 KiB limit", async () => {
    const avatarUrl = `data:image/webp;base64,${"A".repeat(50_000)}`;
    const response = await PATCH(profileRequest({ avatar_url: avatarUrl }));

    expect(response.status).toBe(200);
    expect(mocks.updateAccountProfile).toHaveBeenCalledWith({}, "account-1", {
      avatarUrl,
    });
  });

  it("allows the user to clear an avatar", async () => {
    const response = await PATCH(profileRequest({ avatar_url: null }));

    expect(response.status).toBe(200);
    expect(mocks.updateAccountProfile).toHaveBeenCalledWith({}, "account-1", {
      avatarUrl: null,
    });
  });

  it("rejects a request above the profile route limit", async () => {
    const request = profileRequest({ display_name: "Lin" });
    request.headers.set("content-length", String(512 * 1024 + 1));
    const response = await PATCH(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large" },
    });
    expect(mocks.updateAccountProfile).not.toHaveBeenCalled();
  });

  it("maps invalid avatar data to a safe validation error", async () => {
    mocks.updateAccountProfile.mockRejectedValue(
      new RangeError("invalid_avatar_url"),
    );
    const response = await PATCH(
      profileRequest({ avatar_url: "data:image/svg+xml;base64,PHN2Zy8+" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_profile" },
    });
  });
});
