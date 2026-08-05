import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it } from "vitest";

import { loadPublicContents } from "./content-queries";

function publicDatabase(rows: object[]): AttentionDatabase {
  return {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                orderBy: async () => rows,
              };
            },
          };
        },
      };
    },
  } as unknown as AttentionDatabase;
}

function attribution(overrides: {
  attentionId: string | null;
  displayName: string;
  stableHandle: string;
}) {
  return {
    aiSummary: "摘要",
    aiTags: ["测试"],
    author: null,
    firstPublicAt: new Date("2026-08-01T00:00:00.000Z"),
    outboundUrl: "https://example.com/story",
    publicId: "public-content-1",
    publishedAt: null,
    source: "web",
    summaryStatus: "ready" as const,
    title: "测试内容",
    ...overrides,
  };
}

describe("loadPublicContents public attribution DTO", () => {
  it("keeps distinct null-ID collectors and strips their stable handles", async () => {
    const result = await loadPublicContents(
      publicDatabase([
        attribution({
          attentionId: null,
          displayName: "甲",
          stableHandle: "internal-alpha",
        }),
        attribution({
          attentionId: null,
          displayName: "乙",
          stableHandle: "internal-beta",
        }),
        attribution({
          attentionId: null,
          displayName: "甲",
          stableHandle: "internal-alpha",
        }),
      ]),
    );

    expect(result[0]?.filters).toEqual([
      { attentionId: null, displayName: "甲", initials: "甲" },
      { attentionId: null, displayName: "乙", initials: "乙" },
    ]);
    expect(JSON.stringify(result)).not.toContain("internal-alpha");
    expect(JSON.stringify(result)).not.toContain("internal-beta");
    expect(JSON.stringify(result)).not.toContain("stableHandle");
  });
});
