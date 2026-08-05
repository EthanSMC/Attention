import { describe, expect, it } from "vitest";

import { trustedClientSource, TrustedClientSourceError } from "./trusted-client-source";

describe("trusted client source", () => {
  it("uses only the configured ingress-owned header", () => {
    const request = new Request("https://attention.example/login", {
      headers: {
        "x-attention-client-source": "203.0.113.8",
        "x-forwarded-for": "198.51.100.4",
      },
    });
    expect(trustedClientSource(request, {
      ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER: "x-attention-client-source",
      NODE_ENV: "production",
    })).toBe("203.0.113.8");
  });

  it("fails closed when production ingress identity is not configured", () => {
    expect(() => trustedClientSource(
      new Request("https://attention.example/login"),
      { NODE_ENV: "production" },
    )).toThrow(TrustedClientSourceError);
  });

  it.each([
    "forwarded",
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "fastly-client-ip",
  ])("rejects conventional forwarding header configuration: %s", (headerName) => {
    expect(() => trustedClientSource(
      new Request("https://attention.example/login", {
        headers: { [headerName]: "203.0.113.8" },
      }),
      {
        ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER: headerName,
        NODE_ENV: "production",
      },
    )).toThrow(TrustedClientSourceError);
  });

  it("uses one local bucket outside production without trusting forwarded headers", () => {
    const request = new Request("http://localhost:3000/login", {
      headers: { "x-forwarded-for": "198.51.100.4" },
    });
    expect(trustedClientSource(request, { NODE_ENV: "test" })).toBe("local-development");
  });
});
