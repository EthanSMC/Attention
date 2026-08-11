import type {
  OAuthConnectionNameResult,
  SessionPrincipal,
  ValidatedAuthorizationRequest,
} from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleOAuthAuthorizationConfirmRequest } from "./handler";

const accountId = "10000000-0000-4000-8000-000000000001";
const connectionId = "20000000-0000-4000-8000-000000000002";
const validatedAuthorization: ValidatedAuthorizationRequest = {
  audience: "attention-mcp",
  clientId: "client-1",
  clientName: "Codex",
  codeChallenge: "a".repeat(43),
  redirectUri: "http://127.0.0.1:43820/callback",
  resource: "https://attention.example/mcp",
  scopes: ["profile:read"],
  state: "opaque-state",
};
const validatedRuntimeAuthorization: ValidatedAuthorizationRequest = {
  ...validatedAuthorization,
  audience: "attention-channel-runtime",
  clientId: "runtime-client-2",
  clientName: "Attention Local Channel Runtime",
  resource: "https://attention.example/api/runtime",
  scopes: [
    "channel:bind:report",
    "channel:disconnect:report",
    "runtime:heartbeat",
    "runtime:register",
  ],
};

function principal(): SessionPrincipal {
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
  };
}

function request(overrides: Record<string, string> = {}): NextRequest {
  const body = new URLSearchParams({
    client_id: "client-1",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    connection_label: "Office MacBook",
    redirect_uri: "http://127.0.0.1:43820/callback",
    resource: "https://attention.example/mcp",
    response_type: "code",
    scope: "profile:read",
    state: "opaque-state",
    ...overrides,
  }).toString();
  return new Request("https://attention.example/oauth/authorize/confirm", {
    body,
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/x-www-form-urlencoded",
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
  return {
    checkName: vi.fn(async () => result),
    createCode: vi.fn(async () => "authorization-code"),
    database: {} as AttentionDatabase,
    loadSession: vi.fn(async () => ({
      principal: principal(),
      shouldClearCookie: false,
    })),
    resolveRuntimeIntent: vi.fn(async () => ({
      connectionId,
      label: "Renamed Studio Runtime",
      mode: "rotate" as const,
    })),
    validateRequest: vi.fn(async () => validatedAuthorization),
  };
}

function replaceable(): OAuthConnectionNameResult {
  return {
    existing: {
      clientName: "Codex",
      connectionId,
      createdAt: new Date("2026-08-10T10:00:00.000Z"),
      lastUsedAt: new Date("2026-08-11T10:00:00.000Z"),
    },
    label: "Office MacBook",
    normalizedLabel: "office macbook",
    status: "replaceable",
  };
}

describe("OAuth authorization confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revalidates the OAuth request and creates a code for an available name", async () => {
    const deps = dependencies();

    const response = await handleOAuthAuthorizationConfirmRequest(request(), deps);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:43820/callback?code=authorization-code&state=opaque-state",
    );
    expect(deps.validateRequest).toHaveBeenCalledWith(
      deps.database,
      expect.objectContaining({
        clientId: "client-1",
        resource: "https://attention.example/mcp",
      }),
    );
    expect(deps.checkName).toHaveBeenCalledWith(deps.database, {
      accountId,
      audience: "attention-mcp",
      label: "Office MacBook",
    });
    expect(deps.createCode).toHaveBeenCalledWith(
      deps.database,
      accountId,
      validatedAuthorization,
      { label: "Office MacBook", mode: "create" },
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts only the exact active replacement returned by server revalidation", async () => {
    const deps = dependencies(replaceable());

    const response = await handleOAuthAuthorizationConfirmRequest(
      request({ replacement_connection_id: connectionId }),
      deps,
    );

    expect(response.status).toBe(303);
    expect(deps.createCode).toHaveBeenCalledWith(
      deps.database,
      accountId,
      validatedAuthorization,
      {
        label: "Office MacBook",
        mode: "replace",
        replacementConnectionId: connectionId,
      },
    );
  });

  it("returns a duplicate without replacement to a recoverable authorization state", async () => {
    const deps = dependencies(replaceable());

    const response = await handleOAuthAuthorizationConfirmRequest(request(), deps);

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://attention.example/oauth/authorize",
    );
    expect(location.searchParams.get("connection_label")).toBe("Office MacBook");
    expect(location.searchParams.get("connection_error")).toBe("name_conflict");
    expect(deps.createCode).not.toHaveBeenCalled();
  });

  it("rejects a stale or cross-account replacement target", async () => {
    const deps = dependencies(replaceable());

    const response = await handleOAuthAuthorizationConfirmRequest(
      request({
        replacement_connection_id:
          "90000000-0000-4000-8000-000000000009",
      }),
      deps,
    );

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("connection_error"))
      .toBe("name_conflict");
    expect(deps.createCode).not.toHaveBeenCalled();
  });

  it("returns invalid labels to the page without discarding the typed value", async () => {
    const deps = dependencies();
    deps.checkName.mockRejectedValue(new Error("invalid_connection_label"));

    const response = await handleOAuthAuthorizationConfirmRequest(
      request({ connection_label: "  bad\u0000name  " }),
      deps,
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("connection_label")).toBe("  bad\u0000name  ");
    expect(location.searchParams.get("connection_error")).toBe(
      "invalid_connection_label",
    );
    expect(deps.createCode).not.toHaveBeenCalled();
  });

  it("maps a concurrent unique-index race to the recoverable name-conflict state", async () => {
    const deps = dependencies();
    deps.createCode.mockRejectedValue({
      code: "23505",
      constraint: "oauth_connections_active_name_unique",
    });

    const response = await handleOAuthAuthorizationConfirmRequest(request(), deps);

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("connection_error"))
      .toBe("name_conflict");
  });

  it("does not trust connection intent before full OAuth request validation", async () => {
    const deps = dependencies();
    deps.validateRequest.mockRejectedValue(new Error("invalid_request"));

    const response = await handleOAuthAuthorizationConfirmRequest(request(), deps);

    expect(response.status).toBe(400);
    expect(deps.checkName).not.toHaveBeenCalled();
    expect(deps.createCode).not.toHaveBeenCalled();
  });

  it("rotates the trusted Runtime installation while preserving the typed rename", async () => {
    const deps = dependencies();
    deps.validateRequest.mockResolvedValue(validatedRuntimeAuthorization);

    const response = await handleOAuthAuthorizationConfirmRequest(
      request({
        client_id: "runtime-client-2",
        connection_label: "Renamed Studio Runtime",
        resource: "https://attention.example/api/runtime",
        scope: validatedRuntimeAuthorization.scopes.join(" "),
      }),
      deps,
    );

    expect(response.status).toBe(303);
    expect(deps.resolveRuntimeIntent).toHaveBeenCalledWith(deps.database, {
      accountId,
      audience: "attention-channel-runtime",
      clientId: "runtime-client-2",
      label: "Renamed Studio Runtime",
    });
    expect(deps.createCode).toHaveBeenCalledWith(
      deps.database,
      accountId,
      validatedRuntimeAuthorization,
      {
        connectionId,
        label: "Renamed Studio Runtime",
        mode: "rotate",
      },
    );
    expect(deps.checkName).not.toHaveBeenCalled();
  });
});
