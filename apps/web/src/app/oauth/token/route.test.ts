import {
  OAuthConnectionNameConflictError,
} from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it } from "vitest";

import { handleOAuthTokenRequest } from "./route";

function authorizationCodeRequest(): Request {
  return new Request("https://attention.example/oauth/token", {
    body: new URLSearchParams({
      client_id: "conflicting-client",
      code: "c".repeat(43),
      code_verifier: "v".repeat(43),
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:43123/callback",
      resource: "https://attention.example/mcp",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

describe("OAuth token endpoint", () => {
  it("maps a connection-name race to a stable restart-authorization response", async () => {
    const database = {
      transaction: async () => {
        throw new OAuthConnectionNameConflictError();
      },
    } as unknown as AttentionDatabase;

    const response = await handleOAuthTokenRequest(
      authorizationCodeRequest(),
      database,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description: "connection_name_conflict",
    });
  });
});
