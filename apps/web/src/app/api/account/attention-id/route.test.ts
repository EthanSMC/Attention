import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AttentionIdError extends Error {
    constructor(
      readonly code: string,
      readonly nextChangeAt: Date | null = null,
    ) {
      super(code);
    }
  }
  return {
    AttentionIdError,
    clearInvalidSessionCookie: vi.fn(),
    getRequestSession: vi.fn(),
    getWebDatabase: vi.fn(() => ({})),
    updateAttentionId: vi.fn(),
  };
});

vi.mock("../../../../server/account", () => ({
  AttentionIdError: mocks.AttentionIdError,
  updateAttentionId: mocks.updateAttentionId,
}));
vi.mock("../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../server/session", () => ({
  clearInvalidSessionCookie: mocks.clearInvalidSessionCookie,
  getRequestSession: mocks.getRequestSession,
}));

import { PATCH } from "./route";

function attentionIdRequest(attentionId: string): NextRequest {
  return new Request("https://attention.example/api/account/attention-id", {
    body: JSON.stringify({ attention_id: attentionId }),
    headers: {
      "content-type": "application/json",
      origin: "https://attention.example",
      "sec-fetch-site": "same-origin",
    },
    method: "PATCH",
  }) as NextRequest;
}

describe("Attention ID PATCH", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: { accountId: "account-1" },
      shouldClearCookie: false,
    });
    mocks.updateAttentionId.mockResolvedValue({
      attentionId: "lin_ai",
      nextChangeAt: new Date("2027-08-05T00:00:00.000Z"),
    });
  });

  it("requires an authenticated browser session", async () => {
    mocks.getRequestSession.mockResolvedValue({
      principal: null,
      shouldClearCookie: true,
    });
    const response = await PATCH(attentionIdRequest("lin_ai"));

    expect(response.status).toBe(401);
    expect(mocks.clearInvalidSessionCookie).toHaveBeenCalled();
    expect(mocks.updateAttentionId).not.toHaveBeenCalled();
  });

  it("returns the normalized ID and next change date", async () => {
    const response = await PATCH(attentionIdRequest("LIN_AI"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      attention_id: "lin_ai",
      next_change_at: "2027-08-05T00:00:00.000Z",
    });
  });

  it("maps uniqueness conflicts without exposing database details", async () => {
    mocks.updateAttentionId.mockRejectedValue(
      new mocks.AttentionIdError("attention_id_taken"),
    );
    const response = await PATCH(attentionIdRequest("lin_ai"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "attention_id_taken" },
    });
  });

  it("returns the authoritative cooldown date", async () => {
    const nextChangeAt = new Date("2027-08-05T00:00:00.000Z");
    mocks.updateAttentionId.mockRejectedValue(
      new mocks.AttentionIdError("attention_id_cooldown", nextChangeAt),
    );
    const response = await PATCH(attentionIdRequest("lin_next"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "attention_id_cooldown" },
      next_change_at: nextChangeAt.toISOString(),
    });
  });
});
