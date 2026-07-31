import { describe, expect, it } from "vitest";

import { parseSafeOutboundUrl } from "../../../apps/web/src/server/outbound";

describe("controlled outbound URLs", () => {
  it("accepts only absolute HTTP(S) destinations", () => {
    expect(parseSafeOutboundUrl("https://example.com/article")?.href).toBe(
      "https://example.com/article",
    );
    expect(parseSafeOutboundUrl("http://example.com/article")?.href).toBe(
      "http://example.com/article",
    );

    expect(parseSafeOutboundUrl("javascript:alert(1)")).toBeNull();
    expect(parseSafeOutboundUrl("file:///etc/passwd")).toBeNull();
    expect(parseSafeOutboundUrl("/relative/path")).toBeNull();
    expect(parseSafeOutboundUrl(null)).toBeNull();
  });
});
