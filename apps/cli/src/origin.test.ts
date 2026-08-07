import { describe, expect, it } from "vitest";

import {
  normalizeAttentionOrigin,
  requireAttentionOrigin,
  resolveAttentionPublicUrl,
} from "./origin";

describe("Attention origin", () => {
  it("requires HTTPS outside loopback and accepts loopback HTTP", () => {
    expect(normalizeAttentionOrigin("https://attention.example.test/")).toBe(
      "https://attention.example.test",
    );
    expect(() => normalizeAttentionOrigin("http://attention.example.test")).toThrow(
      /HTTPS/,
    );
    expect(normalizeAttentionOrigin("http://127.0.0.1:3300/")).toBe(
      "http://127.0.0.1:3300",
    );
    expect(() =>
      normalizeAttentionOrigin("https://attention.example.test/path"),
    ).toThrow(/must not contain a path/);
  });

  it("rejects credentials and query parameters", () => {
    expect(() => normalizeAttentionOrigin("https://user:pass@example.test")).toThrow(
      /credentials/,
    );
    expect(() => normalizeAttentionOrigin("https://example.test?token=secret")).toThrow(
      /query/,
    );
  });

  it("uses the explicit option before the environment", () => {
    expect(
      requireAttentionOrigin("https://one.example", {
        ATTENTION_ORIGIN: "https://two.example",
      }),
    ).toBe("https://one.example");
    expect(() => requireAttentionOrigin(undefined, {})).toThrow(/--origin/);
  });

  it("resolves manifest paths and templates", () => {
    expect(
      resolveAttentionPublicUrl(
        "https://attention.example",
        "/skills/attention/SKILL.md",
      ),
    ).toBe("https://attention.example/skills/attention/SKILL.md");
    expect(
      resolveAttentionPublicUrl(
        "https://attention.example",
        "{attention_origin}/mcp",
      ),
    ).toBe("https://attention.example/mcp");
  });
});
