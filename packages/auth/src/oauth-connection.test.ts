import { describe, expect, it } from "vitest";
import type { AttentionDatabase } from "@attention/db";

import {
  checkOAuthConnectionName,
  normalizeOAuthConnectionLabel,
  oauthConnectionLabelCandidate,
} from "./oauth-connection";

describe("OAuth connection labels", () => {
  it("adds a numeric suffix while preserving the eighty-code-point limit", () => {
    expect(oauthConnectionLabelCandidate("Codex", 1)).toEqual({
      label: "Codex",
      normalizedLabel: "codex",
    });
    expect(oauthConnectionLabelCandidate("Codex", 2)).toEqual({
      label: "Codex 2",
      normalizedLabel: "codex 2",
    });

    const candidate = oauthConnectionLabelCandidate("x".repeat(80), 12);
    expect([...candidate.label]).toHaveLength(80);
    expect(candidate.label.endsWith(" 12")).toBe(true);
  });

  it("normalizes a client name before adding a suffix", () => {
    expect(oauthConnectionLabelCandidate("  Ｃｏｄｅｘ   Desktop  ", 3)).toEqual({
      label: "Codex Desktop 3",
      normalizedLabel: "codex desktop 3",
    });
  });

  it("rejects invalid ordinal values", () => {
    expect(() => oauthConnectionLabelCandidate("Codex", 0)).toThrowError(
      "invalid_connection_label_ordinal",
    );
    expect(() => oauthConnectionLabelCandidate("Codex", 1.5)).toThrowError(
      "invalid_connection_label_ordinal",
    );
  });

  it("normalizes compatibility forms, JS whitespace, and comparison case", () => {
    expect(normalizeOAuthConnectionLabel("  Office   MacBook  ")).toEqual({
      label: "Office MacBook",
      normalizedLabel: "office macbook",
    });
    expect(normalizeOAuthConnectionLabel("\u3000Ｏｆｆｉｃｅ\tＭａｃ\u00a0")).toEqual({
      label: "Office Mac",
      normalizedLabel: "office mac",
    });
  });

  it("rejects control characters instead of persisting invisible identity", () => {
    expect(() => normalizeOAuthConnectionLabel("bad\u0000name")).toThrowError(
      "invalid_connection_label",
    );
  });

  it.each([
    ["pure zero-width space", "\u200B"],
    ["embedded bidi override", "Office\u202EMac"],
    ["prefixed bidi isolate", "\u2066Office"],
  ])("rejects Unicode format controls: %s", (_case, label) => {
    expect(() => normalizeOAuthConnectionLabel(label)).toThrowError(
      "invalid_connection_label",
    );
  });

  it("accepts one to eighty visible code points and rejects values outside the bound", () => {
    expect(normalizeOAuthConnectionLabel("😀").label).toBe("😀");
    expect(normalizeOAuthConnectionLabel("a".repeat(80)).label).toHaveLength(80);
    expect(() => normalizeOAuthConnectionLabel("   ")).toThrowError(
      "invalid_connection_label",
    );
    expect(() => normalizeOAuthConnectionLabel("a".repeat(81))).toThrowError(
      "invalid_connection_label",
    );
  });

  it("keeps the normalized database value inside the same bound", () => {
    expect(() => normalizeOAuthConnectionLabel("İ".repeat(80))).toThrowError(
      "invalid_connection_label",
    );
  });
});

describe("OAuth connection name availability", () => {
  it("returns the bounded display label when the active name is available", async () => {
    const db = connectionLookupDatabase([]);

    await expect(
      checkOAuthConnectionName(db, {
        accountId: "10000000-0000-4000-8000-000000000001",
        audience: "attention-mcp",
        label: "  Office   MacBook  ",
      }),
    ).resolves.toEqual({
      status: "available",
      label: "Office MacBook",
      normalizedLabel: "office macbook",
    });
  });

  it("reports a case-insensitive active match as explicitly replaceable", async () => {
    const createdAt = new Date("2026-08-10T10:00:00.000Z");
    const lastUsedAt = new Date("2026-08-11T10:00:00.000Z");
    const db = connectionLookupDatabase([
      {
        clientName: "Attention Desktop",
        connectionId: "20000000-0000-4000-8000-000000000002",
        createdAt,
        lastUsedAt,
      },
    ]);

    await expect(
      checkOAuthConnectionName(db, {
        accountId: "10000000-0000-4000-8000-000000000001",
        audience: "attention-mcp",
        label: "OFFICE MACBOOK",
      }),
    ).resolves.toEqual({
      status: "replaceable",
      label: "OFFICE MACBOOK",
      normalizedLabel: "office macbook",
      existing: {
        clientName: "Attention Desktop",
        connectionId: "20000000-0000-4000-8000-000000000002",
        createdAt,
        lastUsedAt,
      },
    });
  });
});

function connectionLookupDatabase(rows: Array<Record<string, unknown>>): AttentionDatabase {
  const query = {
    from: () => query,
    innerJoin: () => query,
    limit: async () => rows,
    where: () => query,
  };
  return {
    select: () => query,
  } as unknown as AttentionDatabase;
}
