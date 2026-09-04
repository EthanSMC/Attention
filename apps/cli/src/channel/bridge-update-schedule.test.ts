import { describe, expect, it } from "vitest";

import {
  BRIDGE_UPDATE_INTERVAL_MS,
  initialBridgeUpdateCheckAt,
  nextBridgeUpdateCheckAt,
} from "./bridge-update-schedule";

describe("Bridge update schedule", () => {
  it("checks immediately on every process start", () => {
    expect(initialBridgeUpdateCheckAt()).toBe(0);
  });

  it("checks exactly one hour after the preceding attempt", () => {
    expect(BRIDGE_UPDATE_INTERVAL_MS).toBe(60 * 60 * 1_000);
    expect(nextBridgeUpdateCheckAt(42)).toBe(42 + 60 * 60 * 1_000);
  });
});
