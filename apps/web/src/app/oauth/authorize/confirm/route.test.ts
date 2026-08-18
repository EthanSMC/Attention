import type {
  SessionPrincipal,
  ValidatedAuthorizationRequest,
} from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleOAuthAuthorizationConfirmRequest } from "./handler";

const accountId = "10000000-0000-4000-8000-000000000001";
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

function dependencies() {
  return {
    createCode: vi.fn(async () => "authorization-code"),
    database: {} as AttentionDatabase,
    loadSession: vi.fn(async () => ({
      principal: principal(),
      shouldClearCookie: false,
    })),
    validateRequest: vi.fn(async () => validatedAuthorization),
  };
}

describe("OAuth authorization confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revalidates the OAuth request and creates an automatic-label code", async () => {
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
    expect(deps.createCode).toHaveBeenCalledWith(
      deps.database,
      accountId,
      validatedAuthorization,
      { mode: "auto" },
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not accept a submitted connection name or replacement target", async () => {
    const deps = dependencies();

    const response = await handleOAuthAuthorizationConfirmRequest(
      request({
        connection_label: "Attacker supplied label",
        replacement_connection_id:
          "90000000-0000-4000-8000-000000000009",
      }),
      deps,
    );

    expect(response.status).toBe(303);
    expect(deps.createCode).toHaveBeenCalledWith(
      deps.database,
      accountId,
      validatedAuthorization,
      { mode: "auto" },
    );
  });

  it("does not trust connection intent before full OAuth request validation", async () => {
    const deps = dependencies();
    deps.validateRequest.mockRejectedValue(new Error("invalid_request"));

    const response = await handleOAuthAuthorizationConfirmRequest(request(), deps);

    expect(response.status).toBe(400);
    expect(deps.createCode).not.toHaveBeenCalled();
  });

  it("uses the same automatic intent for a trusted Runtime request", async () => {
    const deps = dependencies();
    deps.validateRequest.mockResolvedValue(validatedRuntimeAuthorization);

    const response = await handleOAuthAuthorizationConfirmRequest(
      request({
        client_id: "runtime-client-2",
        resource: "https://attention.example/api/runtime",
        scope: validatedRuntimeAuthorization.scopes.join(" "),
      }),
      deps,
    );

    expect(response.status).toBe(303);
    expect(deps.createCode).toHaveBeenCalledWith(
      deps.database,
      accountId,
      validatedRuntimeAuthorization,
      { mode: "auto" },
    );
  });
});
