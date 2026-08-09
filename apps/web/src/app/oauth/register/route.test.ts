import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it, vi } from "vitest";

import { handleOAuthRegistrationRequest } from "./route";

function registrationDatabase(inserted: Array<Record<string, unknown>>): AttentionDatabase {
  const transaction = {
    execute: async () => undefined,
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
      },
    }),
    select: () => ({
      from: () => ({
        where: async () => [{ value: 0 }],
      }),
    }),
  };
  return {
    transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as AttentionDatabase;
}

function rateLimitedRegistrationDatabase(): AttentionDatabase {
  let selection = 0;
  const transaction = {
    execute: async () => undefined,
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({
        where: async () => {
          selection += 1;
          return [{ value: selection === 1 ? 0 : 10 }];
        },
      }),
    }),
  };
  return {
    transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as AttentionDatabase;
}

describe("OAuth dynamic registration request limits", () => {
  it("accepts the exact metadata emitted by Codex CLI", async () => {
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "attention-registration-test-secret-at-least-32-characters",
    );
    const inserted: Array<Record<string, unknown>> = [];
    try {
      const response = await handleOAuthRegistrationRequest(
        new Request("https://attention.example/oauth/register", {
          body: JSON.stringify({
            application_type: "native",
            client_name: "Codex",
            grant_types: ["authorization_code", "refresh_token"],
            redirect_uris: [
              "http://127.0.0.1:56046/callback/Ui-hkzeEt_FU",
            ],
            response_types: ["code"],
            scope:
              "profile:read collection:read collection:write digest:read digest:write moderation:write moderation:court:read moderation:court:vote public:read public:full ai:search subscription:read",
            token_endpoint_auth_method: "none",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        registrationDatabase(inserted),
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        application_type: "native",
        client_name: "Codex",
        token_endpoint_auth_method: "none",
      });
      expect(inserted).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports registration quota exhaustion as retryable instead of invalid metadata", async () => {
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "attention-registration-test-secret-at-least-32-characters",
    );
    vi.stubEnv("ATTENTION_OAUTH_REGISTRATION_SOURCE_HOURLY_LIMIT", "10");
    try {
      const response = await handleOAuthRegistrationRequest(
        new Request("https://attention.example/oauth/register", {
          body: JSON.stringify({
            client_name: "Codex",
            redirect_uris: ["http://127.0.0.1:56046/callback/random"],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        rateLimitedRegistrationDatabase(),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("3600");
      await expect(response.json()).resolves.toEqual({
        error: "temporarily_unavailable",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it("rejects a partial runtime scope registration", async () => {
    const response = await handleOAuthRegistrationRequest(
      new Request("https://attention.example/oauth/register", {
        body: JSON.stringify({
          client_name: "Partial runtime client",
          redirect_uris: ["http://127.0.0.1:43123/callback"],
          scope: "runtime:register",
        }),
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

  it("persists and returns canonical exact runtime scopes", async () => {
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "attention-registration-test-secret-at-least-32-characters",
    );
    const inserted: Array<Record<string, unknown>> = [];
    try {
      const response = await handleOAuthRegistrationRequest(
        new Request("https://attention.example/oauth/register", {
          body: JSON.stringify({
            client_name: "Runtime client",
            redirect_uris: ["http://127.0.0.1:43123/callback"],
            scope:
              "runtime:heartbeat channel:disconnect:report runtime:register channel:bind:report",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        registrationDatabase(inserted),
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        scope:
          "channel:bind:report channel:disconnect:report runtime:heartbeat runtime:register",
      });
      expect(inserted[0]?.allowedScopes).toEqual([
        "channel:bind:report",
        "channel:disconnect:report",
        "runtime:heartbeat",
        "runtime:register",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
