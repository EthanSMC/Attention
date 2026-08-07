import { apiKeyScopes } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it } from "vitest";

import { loadConnectionOverview } from "./account";

function connectionDatabase(input: {
  oauth?: object[];
  pats: object[];
}): AttentionDatabase {
  let queryIndex = 0;
  return {
    select() {
      queryIndex += 1;
      if (queryIndex === 1) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return { orderBy: async () => input.oauth ?? [] };
                  },
                };
              },
            };
          },
        };
      }
      return {
        from() {
          return {
            where() {
              return { orderBy: async () => input.pats };
            },
          };
        },
      };
    },
  } as unknown as AttentionDatabase;
}

function apiKey(scopes: string[]) {
  return {
    createdAt: new Date("2026-08-07T00:00:00.000Z"),
    expiresAt: null,
    id: crypto.randomUUID(),
    keyPrefix: "att_pat_example",
    lastUsedAt: null,
    name: "Local Agent",
    scopes,
    status: "active" as const,
  };
}

describe("loadConnectionOverview API Key scope truth", () => {
  it("keeps stored scopes and marks a legacy narrow-scope Key for rotation", async () => {
    const result = await loadConnectionOverview(
      connectionDatabase({ pats: [apiKey(["collection:read"])] }),
      crypto.randomUUID(),
    );

    expect(result.pats[0]).toMatchObject({
      needsRotation: true,
      scopes: ["collection:read"],
    });
  });

  it("recognizes a newly created full-scope Key as current", async () => {
    const result = await loadConnectionOverview(
      connectionDatabase({ pats: [apiKey([...apiKeyScopes])] }),
      crypto.randomUUID(),
    );

    expect(result.pats[0]).toMatchObject({
      needsRotation: false,
      scopes: apiKeyScopes,
    });
  });
});
