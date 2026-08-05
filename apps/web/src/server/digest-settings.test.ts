import { describe, expect, it } from "vitest";

import {
  formatWindowStart,
  isValidTimeZone,
  parseWindowStart,
} from "./digest-settings";

describe("digest settings validation", () => {
  it("parses and formats same-day send window starts", () => {
    expect(parseWindowStart("08:30")).toBe(510);
    expect(formatWindowStart(510)).toBe("08:30");
    expect(parseWindowStart("24:00")).toBeNull();
    expect(parseWindowStart("8:30")).toBeNull();
  });

  it("accepts IANA timezones and rejects unknown values", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/A-Timezone")).toBe(false);
  });
});
