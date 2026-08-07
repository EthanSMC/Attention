import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it } from "vitest";

import type { CloudPrincipal } from "./cloud-credentials";
import {
  consumeMcpRequestBudget,
  mcpRateLimitClientKey,
  mcpRequestsPerMinute,
} from "./mcp-rate-limit";

const oauthPrincipal: CloudPrincipal = {
  accountId: "00000000-0000-4000-8000-000000000001",
  clientId: "codex-desktop",
  credentialId: "00000000-0000-4000-8000-000000000002",
  credentialKind: "oauth",
  isFilter: false,
  isMember: true,
  scopes: ["collection:read"],
};

function databaseReturning(requestCount: number): AttentionDatabase {
  const tx = {
    delete() {
      return { where: async () => undefined };
    },
    execute: async () => undefined,
    insert() {
      return {
        values() {
          return {
            onConflictDoUpdate() {
              return {
                returning: async () => [{ requestCount }],
              };
            },
          };
        },
      };
    },
  };
  return {
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
      callback(tx),
  } as unknown as AttentionDatabase;
}

describe("MCP distributed request budget", () => {
  it("uses a bounded deployment setting with a production-safe default", () => {
    expect(mcpRequestsPerMinute(undefined)).toBe(120);
    expect(mcpRequestsPerMinute("240")).toBe(240);
    for (const invalid of ["9", "1001", "12.5", "nope"]) {
      expect(() => mcpRequestsPerMinute(invalid)).toThrow(
        /ATTENTION_MCP_REQUESTS_PER_MINUTE/u,
      );
    }
  });

  it("uses an opaque stable key and separates OAuth clients from PATs", () => {
    const oauthKey = mcpRateLimitClientKey(oauthPrincipal);
    expect(oauthKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(mcpRateLimitClientKey({ ...oauthPrincipal })).toBe(oauthKey);
    expect(
      mcpRateLimitClientKey({
        ...oauthPrincipal,
        clientId: null,
        credentialKind: "pat",
      }),
    ).not.toBe(oauthKey);
    expect(oauthKey).not.toContain(oauthPrincipal.clientId!);
  });

  it("returns the remaining budget before and after the fixed-window limit", async () => {
    const now = new Date("2026-08-07T12:34:45.250Z");
    await expect(
      consumeMcpRequestBudget(databaseReturning(2), oauthPrincipal, {
        limit: 3,
        now,
      }),
    ).resolves.toEqual({
      allowed: true,
      limit: 3,
      remaining: 1,
      retryAfterSeconds: 15,
    });
    await expect(
      consumeMcpRequestBudget(databaseReturning(4), oauthPrincipal, {
        limit: 3,
        now,
      }),
    ).resolves.toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      retryAfterSeconds: 15,
    });
  });
});
