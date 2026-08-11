import type {
  OAuthConnectionNameResult,
  SessionPrincipal,
} from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleOAuthConnectionNameRequest } from "./handler";

const accountId = "10000000-0000-4000-8000-000000000001";
const connectionId = "20000000-0000-4000-8000-000000000002";

function principal(overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  return {
    accountId,
    attentionId: "attn_test",
    authenticatedAt: new Date("2026-08-11T10:00:00.000Z"),
    displayName: "Test User",
    expiresAt: new Date("2026-09-11T10:00:00.000Z"),
    isFilter: false,
    isMember: true,
    primaryEmail: "test@example.com",
    sessionId: "30000000-0000-4000-8000-000000000003",
    signupSource: "direct",
    ...overrides,
  };
}

function request(body: unknown): NextRequest {
  const source = JSON.stringify(body);
  return new Request("https://attention.example/api/oauth/connection-name", {
    body: source,
    headers: {
      "content-length": String(Buffer.byteLength(source)),
      "content-type": "application/json",
      origin: "https://attention.example",
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
  }) as NextRequest;
}

function dependencies(result: OAuthConnectionNameResult = {
  label: "Office MacBook",
  normalizedLabel: "office macbook",
  status: "available",
}) {
  const loadSession = vi.fn(async (): Promise<{
    principal: SessionPrincipal | null;
    shouldClearCookie: boolean;
  }> => ({
    principal: principal(),
    shouldClearCookie: false,
  }));
  return {
    checkName: vi.fn(async () => result),
    database: {} as AttentionDatabase,
    loadActiveClient: vi.fn(async () => true),
    loadSession,
  };
}

describe("OAuth connection-name API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(
      "ATTENTION_MCP_PUBLIC_URL",
      "https://attention.example/mcp",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires an authenticated browser session without querying connection names", async () => {
    const deps = dependencies();
    deps.loadSession.mockResolvedValue({ principal: null, shouldClearCookie: false });

    const response = await handleOAuthConnectionNameRequest(
      request({
        client_id: "client-1",
        label: "Office MacBook",
        resource: "https://attention.example/mcp",
      }),
      deps,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "authentication_required",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.checkName).not.toHaveBeenCalled();
  });

  it("returns an available normalized name for the current account and audience", async () => {
    const deps = dependencies();

    const response = await handleOAuthConnectionNameRequest(
      request({
        client_id: "client-1",
        label: "  Office   MacBook  ",
        resource: "https://attention.example/mcp",
      }),
      deps,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      label: "Office MacBook",
      normalizedLabel: "office macbook",
      status: "available",
    });
    expect(deps.checkName).toHaveBeenCalledWith(deps.database, {
      accountId,
      audience: "attention-mcp",
      label: "  Office   MacBook  ",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns only the current account's replaceable connection summary", async () => {
    const createdAt = new Date("2026-08-10T10:00:00.000Z");
    const lastUsedAt = new Date("2026-08-11T10:00:00.000Z");
    const deps = dependencies({
      existing: {
        clientName: "Codex",
        connectionId,
        createdAt,
        lastUsedAt,
      },
      label: "Office MacBook",
      normalizedLabel: "office macbook",
      status: "replaceable",
    });

    const response = await handleOAuthConnectionNameRequest(
      request({
        client_id: "client-1",
        label: "Office MacBook",
        resource: "https://attention.example/mcp",
      }),
      deps,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      existing: {
        clientName: "Codex",
        connectionId,
        createdAt: "2026-08-10T10:00:00.000Z",
        lastUsedAt: "2026-08-11T10:00:00.000Z",
      },
      label: "Office MacBook",
      normalizedLabel: "office macbook",
      status: "replaceable",
    });
    expect(deps.checkName).toHaveBeenCalledWith(
      deps.database,
      expect.objectContaining({ accountId }),
    );
  });

  it("does not disclose another account when no current-account match exists", async () => {
    const deps = dependencies();

    const response = await handleOAuthConnectionNameRequest(
      request({
        client_id: "client-1",
        label: "Another account's label",
        resource: "https://attention.example/mcp",
      }),
      deps,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "available" });
    expect(deps.checkName).toHaveBeenCalledWith(deps.database, {
      accountId,
      audience: "attention-mcp",
      label: "Another account's label",
    });
  });

  it("rejects invalid labels inline without exposing server details", async () => {
    const deps = dependencies();
    deps.checkName.mockRejectedValue(new Error("invalid_connection_label"));

    const response = await handleOAuthConnectionNameRequest(
      request({
        client_id: "client-1",
        label: "   ",
        resource: "https://attention.example/mcp",
      }),
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_connection_label",
    });
  });

  it("rejects unknown resources before performing a name lookup", async () => {
    const deps = dependencies();

    const response = await handleOAuthConnectionNameRequest(
      request({
        client_id: "client-1",
        label: "Office MacBook",
        resource: "https://attention.example/unknown",
      }),
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_target" });
    expect(deps.checkName).not.toHaveBeenCalled();
  });

  it("rejects inactive clients before performing a name lookup", async () => {
    const deps = dependencies();
    deps.loadActiveClient.mockResolvedValue(false);

    const response = await handleOAuthConnectionNameRequest(
      request({
        client_id: "inactive-client",
        label: "Office MacBook",
        resource: "https://attention.example/mcp",
      }),
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
    expect(deps.checkName).not.toHaveBeenCalled();
  });
});
