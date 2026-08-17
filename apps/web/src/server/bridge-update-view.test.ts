import { describe, expect, it } from "vitest";

import { bridgeDeviceVersionView } from "./bridge-update-view";

describe("Bridge device version view", () => {
  it.each([
    ["0.3.6", "0.3.6", "0.3.5", "current"],
    ["0.3.5", "0.3.6", "0.3.5", "recommended"],
    ["0.3.4", "0.3.6", "0.3.5", "required"],
    ["1.0.0", "2.0.0", "1.0.0", "manual"],
    ["unknown", "0.3.6", "0.3.5", "unknown"],
  ] as const)(
    "maps installed %s against latest %s to %s",
    (installedVersion, latestVersion, minimumVersion, status) => {
      expect(
        bridgeDeviceVersionView({
          installedVersion,
          latestVersion,
          minimumVersion,
        }),
      ).toEqual({ latestVersion, status });
    },
  );
});
