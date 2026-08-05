import { describe, expect, it } from "vitest";

import {
  digestContentWindow,
  isInsideSendWindow,
  localDateString,
  zonedDateTimeToUtc,
} from "./digest-time";

describe("digest timezone scheduling", () => {
  it("uses the account local date and configured half-open send window", () => {
    const now = new Date("2026-08-04T00:30:00.000Z");
    expect(localDateString(now, "Asia/Shanghai")).toBe("2026-08-04");
    expect(isInsideSendWindow(now, "Asia/Shanghai", 8 * 60, 60)).toBe(true);
    expect(isInsideSendWindow(now, "Asia/Shanghai", 9 * 60, 60)).toBe(false);
    expect(
      isInsideSendWindow(
        new Date("2026-08-04T01:00:00.000Z"),
        "Asia/Shanghai",
        8 * 60,
        60,
      ),
    ).toBe(false);
  });

  it("converts local wall time without assuming a fixed UTC offset", () => {
    expect(
      zonedDateTimeToUtc("2026-08-04", 8 * 60, "Asia/Shanghai").toISOString(),
    ).toBe("2026-08-04T00:00:00.000Z");
    expect(
      zonedDateTimeToUtc("2026-08-04", 8 * 60, "America/New_York").toISOString(),
    ).toBe("2026-08-04T12:00:00.000Z");
  });

  it("makes the previous local day 23 or 25 hours across DST", () => {
    const spring = digestContentWindow("2026-03-09", "America/New_York");
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 60 * 60 * 1_000);

    const autumn = digestContentWindow("2026-11-02", "America/New_York");
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 60 * 60 * 1_000);
  });
});
