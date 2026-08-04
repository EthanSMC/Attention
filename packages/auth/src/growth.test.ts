import { describe, expect, it } from "vitest";

import { addCalendarMonths } from "./growth";

describe("growth calendar grants", () => {
  it.each([
    ["2026-01-31T12:34:56.789Z", 1, "2026-02-28T12:34:56.789Z"],
    ["2024-02-29T08:00:00.000Z", 12, "2025-02-28T08:00:00.000Z"],
    ["2026-08-04T09:10:11.012Z", 3, "2026-11-04T09:10:11.012Z"],
  ])("adds UTC calendar months without rolling into the next month", (start, months, end) => {
    expect(addCalendarMonths(new Date(start), months).toISOString()).toBe(end);
  });

  it.each([0, -1, 121, 1.5])("rejects an invalid grant month count: %s", (months) => {
    expect(() => addCalendarMonths(new Date(), months)).toThrow(RangeError);
  });
});
