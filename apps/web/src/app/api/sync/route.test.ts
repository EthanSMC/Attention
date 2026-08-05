import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebDatabase: vi.fn(() => ({})),
  pushSyncMutations: vi.fn(),
  resolveCloudPrincipal: vi.fn(),
}));

vi.mock("../../../server/cloud-credentials", () => ({
  resolveCloudPrincipal: mocks.resolveCloudPrincipal,
}));
vi.mock("../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../server/oauth-resources", () => ({
  oauthResourceMetadataUrl: vi.fn(() => "https://attention.example/.well-known/oauth-protected-resource/api/sync"),
}));
vi.mock("../../../server/sync-service", () => ({
  pullSyncEvents: vi.fn(),
  pushSyncMutations: mocks.pushSyncMutations,
}));

import { POST } from "./route";

describe("sync push request limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCloudPrincipal.mockResolvedValue({
      accountId: "account-1",
      isFilter: true,
      isMember: true,
      scopes: ["sync:write"],
    });
  });

  it("cancels an authenticated chunked body as soon as it crosses the byte limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(8 * 1_024 * 1_024 + 1));
            return;
          }
          controller.error(new Error("request continued after cancellation"));
        }
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://attention.example/api/sync", {
      body,
      duplex: "half",
      headers: { "content-type": "application/json" },
      method: "POST",
    } as RequestInit & { duplex: "half" });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large" },
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
    expect(mocks.pushSyncMutations).not.toHaveBeenCalled();
  });

  it("preserves a valid authenticated sync push", async () => {
    mocks.pushSyncMutations.mockResolvedValue({
      results: [{ client_mutation_id: "mutation-1", status: "applied" }],
    });
    const request = new Request("https://attention.example/api/sync", {
      body: JSON.stringify({
        mutations: [
          {
            client_mutation_id: "mutation-1",
            collection_id: "3a9580b0-21b1-4ea7-9004-88c20a310503",
            op: "delete",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(200);
    expect(mocks.pushSyncMutations).toHaveBeenCalledOnce();
  });
});
