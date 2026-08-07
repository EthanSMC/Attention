import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as CollectionStatusServiceModule from "../../../../../../../server/collection-status-service";

const collectionId = "00000000-0000-4000-8000-000000000005";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  getWebDatabase: vi.fn(() => ({})),
  updateCollectionVisibility: vi.fn(),
}));

vi.mock("../../../../../../../server/api-guard", () => ({
  mutationRequestError: vi.fn(() => null),
  noStoreJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock("../../../../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../../../../server/request-body", () => ({
  InvalidRequestBodyError: class InvalidRequestBodyError extends Error {},
  readJsonRequestWithinLimit: vi.fn(async () => ({ visibility: "private" })),
  RequestBodyTooLargeError: class RequestBodyTooLargeError extends Error {},
}));
vi.mock("../../../../../../../server/session", () => ({
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: mocks.getRequestSession,
}));
vi.mock(
  "../../../../../../../server/collection-status-service",
  async (importOriginal) => {
    const original = await importOriginal<typeof CollectionStatusServiceModule>();
    return {
      ...original,
      updateCollectionVisibility: mocks.updateCollectionVisibility,
    };
  },
);

import { PATCH } from "./route";

describe("Web collection visibility adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: {
        accountId: "00000000-0000-4000-8000-000000000001",
        isFilter: true,
      },
    });
    mocks.updateCollectionVisibility.mockResolvedValue({
      collection_id: collectionId,
      effectively_public: false,
      original_url: `/out/mine/${collectionId}`,
      updated_at: "2026-08-07T00:00:00.000Z",
      visibility: "private",
    });
  });

  it("uses the same collection-status Core adapter as MCP", async () => {
    const request = new Request(
      `https://attention.example/api/v1/me/collections/${collectionId}/visibility`,
      { body: JSON.stringify({ visibility: "private" }), method: "PATCH" },
    );

    const response = await PATCH(request as NextRequest, {
      params: Promise.resolve({ collectionId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ visibility: "private" });
    expect(mocks.updateCollectionVisibility).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: "00000000-0000-4000-8000-000000000001",
      }),
      { collection_id: collectionId, visibility: "private" },
    );
  });
});
