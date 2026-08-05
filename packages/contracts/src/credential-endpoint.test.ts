import { describe, expect, it } from "vitest";

import { normalizeCredentialEndpoint } from "./credential-endpoint";

describe("credential endpoint URL policy", () => {
  it.each([
    "http://service.example/api",
    "https://user:password@service.example/api",
    "https://service.example/api?token=unsafe",
    "https://service.example/api#fragment",
    "file:///tmp/socket",
  ])("rejects an unsafe credential target: %s", (value) => {
    expect(() => normalizeCredentialEndpoint(value, "SERVICE_URL")).toThrow();
  });

  it.each([
    ["https://service.example/api/", "https://service.example/api"],
    ["http://127.0.0.1:4100/", "http://127.0.0.1:4100"],
    ["http://localhost:4100/api", "http://localhost:4100/api"],
    ["http://[::1]:4100/api", "http://[::1]:4100/api"],
  ])("normalizes an allowed target: %s", (value, expected) => {
    expect(normalizeCredentialEndpoint(value, "SERVICE_URL")).toBe(expected);
  });

  it("allows only an explicitly named same-stack HTTP service", () => {
    expect(normalizeCredentialEndpoint(
      "http://fetcher:4100",
      "FETCHER_BASE_URL",
      { allowedInsecureHosts: ["fetcher"] },
    )).toBe("http://fetcher:4100");
    expect(() => normalizeCredentialEndpoint(
      "http://other-service:4100",
      "FETCHER_BASE_URL",
      { allowedInsecureHosts: ["fetcher"] },
    )).toThrow(/HTTPS/u);
  });
});
