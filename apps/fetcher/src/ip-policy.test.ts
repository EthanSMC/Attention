import { describe, expect, it } from "vitest";

import { isPublicAddress, isUnsafeHostname } from "./ip-policy.js";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1"
  ])("rejects %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    }
  );
});

describe("isUnsafeHostname", () => {
  it.each(["localhost", "foo.localhost", "printer.local", "service.internal"])(
    "rejects %s",
    (hostname) => {
      expect(isUnsafeHostname(hostname)).toBe(true);
    }
  );

  it("allows a normal public hostname", () => {
    expect(isUnsafeHostname("example.com")).toBe(false);
  });
});
