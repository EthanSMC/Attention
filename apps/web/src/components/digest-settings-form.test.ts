import { describe, expect, it } from "vitest";

import { latestDigestWindowStart } from "../lib/digest-time";

describe("latestDigestWindowStart", () => {
  it("keeps a sixty-minute delivery window inside the local day", () => {
    expect(latestDigestWindowStart(60)).toBe("23:00");
  });

  it("respects an existing four-hour delivery window", () => {
    expect(latestDigestWindowStart(240)).toBe("20:00");
  });
});
