import { describe, expect, it } from "vitest";

import { truncateUtf8 } from "./text.js";

describe("UTF-8 text limits", () => {
  it("does not split multibyte characters while enforcing byte limits", () => {
    const result = truncateUtf8("你".repeat(1_000), 2_000);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(2_000);
    expect(result.endsWith("你")).toBe(true);
    expect(result).not.toContain("�");
  });
});
