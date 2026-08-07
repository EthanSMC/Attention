import type { AttentionDatabase } from "@attention/db";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { POST as startEmailLogin } from "./api/auth/email/start/route";
import { POST as verifyEmailLogin } from "./api/auth/email/verify/route";
import { POST as passwordLogin } from "./api/auth/password/route";
import { handleMcpProtectedResourceMetadataRequest } from "./.well-known/oauth-protected-resource/route";
import { handleMcpRequest } from "./mcp/route";
import { handleOAuthRevokeRequest } from "./oauth/revoke/route";
import { handleOAuthTokenRequest } from "./oauth/token/route";

function oversizedChunkedRequest(url: string, contentType: string): {
  cancelled: () => boolean;
  pulls: () => number;
  request: Request;
} {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array(65_537));
        return;
      }
      controller.error(new Error("oversized request continued after cancellation"));
    },
  });
  const request = new Request(url, {
    body,
    duplex: "half",
    headers: { "content-type": contentType },
    method: "POST",
  } as RequestInit & { duplex: "half" });
  return {
    cancelled: () => cancelled,
    pulls: () => pulls,
    request,
  };
}

async function expectCancelled(
  input: ReturnType<typeof oversizedChunkedRequest>,
  response: Response,
): Promise<void> {
  expect(response.status).toBe(413);
  expect(input.cancelled()).toBe(true);
  expect(input.pulls()).toBe(1);
}

describe("public route request body limits", () => {
  it("cancels an oversized chunked email-start body", async () => {
    const input = oversizedChunkedRequest(
      "https://attention.example/api/auth/email/start",
      "application/json",
    );
    const response = await startEmailLogin(input.request as NextRequest);

    await expectCancelled(input, response);
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large" },
    });
  });

  it("cancels an oversized chunked password-login body", async () => {
    const input = oversizedChunkedRequest(
      "https://attention.example/api/auth/password",
      "application/json",
    );
    const response = await passwordLogin(input.request as NextRequest);

    await expectCancelled(input, response);
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large" },
    });
  });

  it("cancels an oversized chunked email-verification body", async () => {
    const input = oversizedChunkedRequest(
      "https://attention.example/api/auth/email/verify",
      "application/json",
    );
    const response = await verifyEmailLogin(input.request as NextRequest);

    await expectCancelled(input, response);
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large" },
    });
  });

  it("cancels an oversized chunked OAuth token body", async () => {
    const input = oversizedChunkedRequest(
      "https://attention.example/oauth/token",
      "application/x-www-form-urlencoded",
    );
    const response = await handleOAuthTokenRequest(
      input.request,
      {} as AttentionDatabase,
    );

    await expectCancelled(input, response);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("cancels an oversized chunked OAuth revocation body", async () => {
    const input = oversizedChunkedRequest(
      "https://attention.example/oauth/revoke",
      "application/x-www-form-urlencoded",
    );
    const response = await handleOAuthRevokeRequest(
      input.request,
      {} as AttentionDatabase,
    );

    await expectCancelled(input, response);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("cancels an oversized chunked MCP body before authentication or SDK parsing", async () => {
    const input = oversizedChunkedRequest(
      "https://attention.example/mcp",
      "application/json",
    );
    const resolver = vi.fn(async () => null);
    const response = await handleMcpRequest(input.request, {
      getDatabase: () => ({} as AttentionDatabase),
      principalResolver: resolver,
    });

    await expectCancelled(input, response);
    expect(resolver).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "request_too_large" });
  });

  it("preserves MCP method, headers, and bounded body for downstream authentication", async () => {
    const resolver = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer example");
      expect(request.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      await expect(request.text()).resolves.toBe('{"jsonrpc":"2.0"}');
      return null;
    });
    const response = await handleMcpRequest(
      new Request("https://attention.example/mcp", {
        body: '{"jsonrpc":"2.0"}',
        headers: {
          authorization: "Bearer example",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        method: "POST",
      }),
      {
        getDatabase: () => ({} as AttentionDatabase),
        principalResolver: resolver,
      },
    );

    expect(response.status).toBe(401);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("advertises the MCP resource scopes in the unauthorized challenge", async () => {
    const response = await handleMcpRequest(
      new Request("https://attention.example/mcp", { method: "GET" }),
      {
        getDatabase: () => ({} as AttentionDatabase),
        principalResolver: async () => null,
      },
    );

    expect(response.status).toBe(401);
    const challenge = extractWWWAuthenticateParams(response);
    expect(challenge.resourceMetadataUrl?.href).toBe(
      "https://attention.example/.well-known/oauth-protected-resource",
    );
    expect(challenge.scope).toBe(
      "profile:read collection:read collection:write digest:read digest:write moderation:write moderation:court:read moderation:court:vote public:read public:full ai:search subscription:read",
    );
    const metadataResponse = handleMcpProtectedResourceMetadataRequest(
      new Request("https://attention.example/.well-known/oauth-protected-resource"),
    );
    const metadata = await metadataResponse.json() as {
      scopes_supported: string[];
    };
    expect(metadata.scopes_supported).toEqual([
      "profile:read",
      "collection:read",
      "collection:write",
      "digest:read",
      "digest:write",
      "moderation:write",
      "moderation:court:read",
      "moderation:court:vote",
      "public:read",
      "public:full",
      "ai:search",
      "subscription:read",
    ]);
    expect(
      challenge.scope?.split(" ").every((scope) =>
        metadata.scopes_supported.includes(scope),
      ),
    ).toBe(true);
  });

  it("returns a structured retry response when the shared MCP budget is exhausted", async () => {
    const response = await handleMcpRequest(
      new Request("https://attention.example/mcp", { method: "GET" }),
      {
        getDatabase: () => ({} as AttentionDatabase),
        principalResolver: async () => ({
          accountId: "00000000-0000-4000-8000-000000000001",
          clientId: "codex-desktop",
          credentialId: "00000000-0000-4000-8000-000000000002",
          credentialKind: "oauth",
          isFilter: false,
          isMember: true,
          scopes: ["collection:read"],
        }),
        rateLimitConsumer: async () => ({
          allowed: false,
          limit: 120,
          remaining: 0,
          retryAfterSeconds: 17,
        }),
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      error: "rate_limited",
      retry_after_seconds: 17,
    });
  });

  it("fails closed when the shared MCP budget cannot be verified", async () => {
    const response = await handleMcpRequest(
      new Request("https://attention.example/mcp", { method: "GET" }),
      {
        getDatabase: () => {
          throw new Error("database unavailable");
        },
        principalResolver: async () => ({
          accountId: "00000000-0000-4000-8000-000000000001",
          clientId: null,
          credentialId: "00000000-0000-4000-8000-000000000002",
          credentialKind: "pat",
          isFilter: false,
          isMember: false,
          scopes: ["collection:read"],
        }),
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "rate_limit_unavailable",
      error_description: "Attention could not verify the MCP request budget.",
    });
  });
});
