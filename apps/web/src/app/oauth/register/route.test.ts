import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it, vi } from "vitest";

import { handleOAuthRegistrationRequest } from "./route";

describe("OAuth dynamic registration request limits", () => {
  it("fails closed in production when ingress source identity is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER", "");
    try {
      const response = await handleOAuthRegistrationRequest(
        new Request("https://attention.example/oauth/register", {
          body: JSON.stringify({
            client_name: "Example MCP client",
            redirect_uris: ["http://127.0.0.1:43123/callback"],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        {} as AttentionDatabase,
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns client metadata errors for invalid JSON", async () => {
    const response = await handleOAuthRegistrationRequest(
      new Request("https://attention.example/oauth/register", {
        body: "{not-json",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      {} as AttentionDatabase,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_client_metadata",
    });
  });

  it("cancels a chunked body as soon as it crosses the byte limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(16_385));
          return;
        }
        controller.error(new Error("request continued after cancellation"));
      },
    });
    const request = new Request("https://attention.example/oauth/register", {
      body,
      duplex: "half",
      headers: { "content-type": "application/json" },
      method: "POST",
    } as RequestInit & { duplex: "half" });

    const response = await handleOAuthRegistrationRequest(
      request,
      {} as AttentionDatabase,
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
  });
});
