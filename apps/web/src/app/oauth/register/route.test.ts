import { createHmac } from "node:crypto";

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
  it("persists only HMAC-derived identity for an exact trusted Runtime registration", async () => {
    const secret = "attention-registration-test-secret-at-least-32-characters";
    const installationId = "11111111-1111-4111-8111-111111111111";
    vi.stubEnv("ATTENTION_HMAC_SECRET", secret);
    vi.stubEnv(
      "ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL",
      "https://attention.example/api/runtime",
    );
    const inserted: Array<Record<string, unknown>> = [];
    try {
      const response = await handleOAuthRegistrationRequest(
        new Request("https://attention.example/oauth/register", {
          body: JSON.stringify({
            application_type: "native",
            attention_connection_kind: "runtime",
            attention_device_name: "  Ethan MacBook Pro  ",
            attention_installation_id: installationId,
            client_name: "Attention Local Channel Runtime",
            grant_types: ["authorization_code", "refresh_token"],
            redirect_uris: ["http://127.0.0.1:43123/callback"],
            resource: "https://attention.example/api/runtime",
            response_types: ["code"],
            scope:
              "runtime:heartbeat channel:disconnect:report runtime:register channel:bind:report",
            software_id: "attention-channel-runtime",
            token_endpoint_auth_method: "none",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        registrationDatabase(inserted),
      );

      expect(response.status).toBe(201);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        connectionKind: "runtime",
        deviceName: "Ethan MacBook Pro",
        installationKeyHash: createHmac("sha256", secret)
          .update("attention:runtime-installation:v1\0")
          .update(installationId)
          .digest("hex"),
      });
      expect(JSON.stringify(inserted[0])).not.toContain(installationId);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("discards Runtime identity claims from a generic MCP registration", async () => {
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "attention-registration-test-secret-at-least-32-characters",
    );
    const inserted: Array<Record<string, unknown>> = [];
    try {
      const response = await handleOAuthRegistrationRequest(
        new Request("https://attention.example/oauth/register", {
          body: JSON.stringify({
            attention_connection_kind: "runtime",
            attention_device_name: "Pretend reliable device",
            attention_installation_id:
              "11111111-1111-4111-8111-111111111111",
            client_name: "Codex",
            redirect_uris: ["http://127.0.0.1:43123/callback"],
            resource: "https://attention.example/mcp",
            scope: "profile:read collection:read",
            software_id: "attention-channel-runtime",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        registrationDatabase(inserted),
      );

      expect(response.status).toBe(201);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).not.toHaveProperty("connectionKind");
      expect(inserted[0]).not.toHaveProperty("deviceName");
      expect(inserted[0]).not.toHaveProperty("installationKeyHash");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    [
      "a mismatched resource",
      {
        resource: "https://attention.example/mcp",
        software_id: "attention-channel-runtime",
      },
    ],
    [
      "untrusted software",
      {
        resource: "https://attention.example/api/runtime",
        software_id: "generic-mcp-client",
      },
    ],
  ])("discards Runtime identity claims from %s", async (_name, metadata) => {
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "attention-registration-test-secret-at-least-32-characters",
    );
    const inserted: Array<Record<string, unknown>> = [];
    try {
      const response = await handleOAuthRegistrationRequest(
        new Request("https://attention.example/oauth/register", {
          body: JSON.stringify({
            attention_connection_kind: "runtime",
            attention_device_name: "Pretend reliable device",
            attention_installation_id:
              "11111111-1111-4111-8111-111111111111",
            client_name: "Runtime-shaped client",
            redirect_uris: ["http://127.0.0.1:43123/callback"],
            scope:
              "runtime:heartbeat channel:disconnect:report runtime:register channel:bind:report",
            ...metadata,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        registrationDatabase(inserted),
      );

      expect(response.status).toBe(201);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).not.toHaveProperty("connectionKind");
      expect(inserted[0]).not.toHaveProperty("deviceName");
      expect(inserted[0]).not.toHaveProperty("installationKeyHash");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["a non-UUID installation ID", { attention_installation_id: "serial-number" }],
    ["control characters", { attention_device_name: "Ethan\u0000Mac" }],
    ["a device name over 80 characters", { attention_device_name: "x".repeat(81) }],
  ])("rejects Runtime identity metadata containing %s", async (_name, invalid) => {
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
            attention_connection_kind: "runtime",
            attention_device_name: "Ethan MacBook Pro",
            attention_installation_id: "11111111-1111-4111-8111-111111111111",
            client_name: "Attention Local Channel Runtime",
            redirect_uris: ["http://127.0.0.1:43123/callback"],
            resource: "https://attention.example/api/runtime",
            scope:
              "runtime:heartbeat channel:disconnect:report runtime:register channel:bind:report",
            software_id: "attention-channel-runtime",
            ...invalid,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        registrationDatabase(inserted),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_client_metadata",
      });
      expect(inserted).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("normalizes the exact all-scopes metadata emitted by Codex CLI to the MCP audience", async () => {
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
              "profile:read collection:read collection:write digest:read digest:write moderation:write moderation:court:read moderation:court:vote sync:read sync:write public:read public:full ai:search subscription:read runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report",
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
        scope:
          "ai:search collection:read collection:write digest:read digest:write moderation:court:read moderation:court:vote moderation:write profile:read public:full public:read subscription:read",
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

  it("rejects mixed Runtime and MCP scopes even when identity metadata is supplied", async () => {
    const response = await handleOAuthRegistrationRequest(
      new Request("https://attention.example/oauth/register", {
        body: JSON.stringify({
          attention_connection_kind: "runtime",
          attention_device_name: "Pretend reliable device",
          attention_installation_id: "11111111-1111-4111-8111-111111111111",
          client_name: "Mixed runtime client",
          redirect_uris: ["http://127.0.0.1:43123/callback"],
          resource: "https://attention.example/api/runtime",
          scope: "runtime:register profile:read",
          software_id: "attention-channel-runtime",
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
