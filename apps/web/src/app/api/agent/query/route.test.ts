import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AgentAccessError extends Error {
    readonly code = "membership_required";
  }
  return {
    AgentAccessError,
    getRequestSession: vi.fn(),
    getWebDatabase: vi.fn(() => ({})),
    retrieveForAgent: vi.fn(),
  };
});

vi.mock("../../../../server/agent-retrieval", () => ({
  AgentAccessError: mocks.AgentAccessError,
  retrieveForAgent: mocks.retrieveForAgent,
}));
vi.mock("../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../server/session", () => ({
  clearInvalidSessionCookie: vi.fn(),
  getRequestSession: mocks.getRequestSession,
}));

import { POST } from "./route";

describe("agent query request limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue({
      principal: {
        accountId: "account-1",
        isMember: true,
      },
      shouldClearCookie: false,
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
            controller.enqueue(new Uint8Array(40_961));
            return;
          }
          controller.error(new Error("request continued after cancellation"));
        }
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://attention.example/api/agent/query", {
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
    expect(mocks.retrieveForAgent).not.toHaveBeenCalled();
  });

  it("preserves a valid authenticated agent query", async () => {
    mocks.retrieveForAgent.mockResolvedValue({
      answer: "A useful answer",
      citations: [],
      mode: "deterministic",
    });
    const request = new Request("https://attention.example/api/agent/query", {
      body: JSON.stringify({ query: "find my saved article" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(200);
    expect(mocks.retrieveForAgent).toHaveBeenCalledWith(
      {},
      "account-1",
      "find my saved article",
    );
  });
});
