import { describe, expect, it } from "vitest";
import type { AttentionDatabase } from "@attention/db";

import { apiKeyScopes } from "./api-credentials";
import {
  oauthAudiences,
  oauthDefaultScopesByAudience,
  oauthScopesByAudience,
  registerPublicOAuthClient,
  resolveOAuthClientAllowedScopes,
  resolveOAuthResource,
  validateAuthorizationRequest,
} from "./oauth";

const resources = {
  "attention-channel-runtime": "https://attention.example/api/runtime",
  "attention-mcp": "https://attention.example/mcp",
  "attention-sync": "https://attention.example/api/sync",
} as const;

describe("OAuth resource indicators", () => {
  it("maps canonical resource URIs to separate MCP and sync audiences", () => {
    expect(resolveOAuthResource("HTTPS://ATTENTION.EXAMPLE/mcp", resources)).toEqual({
      audience: "attention-mcp",
      resource: resources["attention-mcp"],
    });
    expect(resolveOAuthResource(resources["attention-sync"], resources)).toEqual({
      audience: "attention-sync",
      resource: resources["attention-sync"],
    });
    expect(
      resolveOAuthResource(resources["attention-channel-runtime"], resources),
    ).toEqual({
      audience: "attention-channel-runtime",
      resource: resources["attention-channel-runtime"],
    });
  });

  it("advertises only the exact control-plane scopes for the runtime audience", () => {
    const expectedRuntimeScopes = [
      "runtime:register",
      "runtime:heartbeat",
      "channel:bind:report",
      "channel:disconnect:report",
    ];

    expect(oauthAudiences).toContain("attention-channel-runtime");
    expect(oauthScopesByAudience["attention-channel-runtime"]).toEqual(
      expectedRuntimeScopes,
    );
    expect(oauthDefaultScopesByAudience["attention-channel-runtime"]).toEqual(
      expectedRuntimeScopes,
    );
  });

  it("requests the complete published MCP scope set on first connection", () => {
    expect(oauthDefaultScopesByAudience["attention-mcp"]).toEqual(
      oauthScopesByAudience["attention-mcp"],
    );
  });

  it.each([
    "",
    "attention.example/mcp",
    "https://attention.example/mcp#fragment",
    "http://attention.example/mcp",
    "https://attention.example/unknown",
  ])("rejects invalid or unknown resource %s", (resource) => {
    expect(() => resolveOAuthResource(resource, resources)).toThrowError(
      expect.objectContaining({ code: "invalid_target" }),
    );
  });

  it("allows loopback HTTP for local MCP development only", () => {
    const localResources = {
      "attention-channel-runtime": "http://localhost:3000/api/runtime",
      "attention-mcp": "http://127.0.0.1:3000/mcp",
      "attention-sync": "http://localhost:3000/api/sync",
    } as const;
    expect(resolveOAuthResource(localResources["attention-mcp"], localResources).audience)
      .toBe("attention-mcp");
  });

  it("rejects a request that mixes scopes from different resource audiences", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                active: true,
                allowedScopes: ["profile:read", "sync:read"],
                clientId: "attention-test-client",
                name: "Attention test client",
                redirectUris: ["http://127.0.0.1:43820/callback"],
              },
            ],
          }),
        }),
      }),
    } as unknown as AttentionDatabase;

    await expect(
      validateAuthorizationRequest(db, {
        clientId: "attention-test-client",
        codeChallenge: "a".repeat(43),
        codeChallengeMethod: "S256",
        redirectUri: "http://127.0.0.1:43820/callback",
        resource: resources["attention-mcp"],
        resources,
        responseType: "code",
        scope: "profile:read sync:read",
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("OAuth dynamic client scope policy", () => {
  it("defaults omitted registration scope to legacy MCP and sync access only", () => {
    expect(resolveOAuthClientAllowedScopes()).toEqual([
      "profile:read",
      "collection:read",
      "collection:write",
      "digest:read",
      "digest:write",
      "moderation:write",
      "moderation:court:read",
      "moderation:court:vote",
      "sync:read",
      "sync:write",
      "public:read",
      "public:full",
      "ai:search",
      "subscription:read",
    ]);
  });

  it("canonicalizes an explicitly requested non-runtime scope ceiling", () => {
    expect(
      resolveOAuthClientAllowedScopes("sync:write collection:read sync:write"),
    ).toEqual(["collection:read", "sync:write"]);
  });

  it("accepts the complete runtime-only scope set in any order", () => {
    expect(
      resolveOAuthClientAllowedScopes(
        "runtime:heartbeat channel:disconnect:report runtime:register channel:bind:report",
      ),
    ).toEqual([
      "channel:bind:report",
      "channel:disconnect:report",
      "runtime:heartbeat",
      "runtime:register",
    ]);
  });

  it.each([
    "runtime:register",
    "runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report sync:read",
  ])("rejects partial or mixed runtime registration scopes: %s", (scope) => {
    expect(() => resolveOAuthClientAllowedScopes(scope)).toThrowError(
      expect.objectContaining({ code: "invalid_scope" }),
    );
  });

  it("rejects an explicitly empty registration scope", () => {
    expect(() => resolveOAuthClientAllowedScopes("   ")).toThrowError(
      expect.objectContaining({ code: "invalid_scope" }),
    );
  });

  it("persists the canonical requested scope ceiling on the client", async () => {
    const inserted: Array<Record<string, unknown>> = [];
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
    const db = {
      transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
        callback(transaction),
    } as unknown as AttentionDatabase;

    await registerPublicOAuthClient(db, {
      allowedScopes: ["collection:read", "sync:write"],
      name: "Runtime client",
      redirectUris: ["http://127.0.0.1:43820/callback"],
      requesterFingerprint: "a".repeat(64),
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.allowedScopes).toEqual([
      "collection:read",
      "sync:write",
    ]);
  });
});

describe("API key scope boundary", () => {
  it("keeps runtime control-plane scopes out of PAT credentials", () => {
    expect(apiKeyScopes).toEqual([
      "profile:read",
      "collection:read",
      "collection:write",
      "digest:read",
      "digest:write",
      "moderation:write",
      "moderation:court:read",
      "moderation:court:vote",
      "sync:read",
      "sync:write",
      "public:read",
      "public:full",
      "ai:search",
      "subscription:read",
    ]);
  });
});
