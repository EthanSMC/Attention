import { describe, expect, it } from "vitest";

import { FetcherError } from "./errors.js";
import { assertNoHttpsDowngrade, parseAndValidateUrl } from "./url-policy.js";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FetcherError);
    expect((error as FetcherError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("parseAndValidateUrl", () => {
  it("accepts a normal HTTPS URL", () => {
    expect(
      parseAndValidateUrl("https://example.com/article?utm_source=test", "generic_web")
        .hostname
    ).toBe("example.com");
  });

  it.each([
    ["file:///etc/passwd", "unsupported_protocol"],
    ["http://127.0.0.1/", "unsafe_address"],
    ["http://localhost/", "unsafe_hostname"],
    ["https://user:pass@example.com/", "unsafe_credentials"],
    ["https://example.com:8443/", "unsupported_port"],
    ["https://example.com/?access_token=sentinel", "unsafe_credentials"],
    ["https://example.com/?token=sentinel", "unsafe_credentials"],
    ["https://example.com/callback#access_token=sentinel", "unsafe_credentials"],
    ["https://example.com/callback#/done?id_token=sentinel", "unsafe_credentials"]
  ])("rejects %s", (raw, code) => {
    expectCode(() => parseAndValidateUrl(raw, "generic_web"), code);
  });

  it("permits the known public Xiaohongshu share token", () => {
    expect(
      parseAndValidateUrl(
        "https://www.xiaohongshu.com/explore/abc123?xsec_token=public-share",
        "xiaohongshu"
      ).hostname
    ).toBe("www.xiaohongshu.com");
  });

  it.each([
    "https://www.xiaohongshu.com/account?xsec_token=not-a-public-content-token",
    "https://www.xiaohongshu.com.evil.example/explore/abc123?xsec_token=sentinel",
    "https://example.com/explore/abc123?xsec_token=sentinel"
  ])("does not apply the Xiaohongshu exception to %s", (url) => {
    expectCode(() => parseAndValidateUrl(url, "xiaohongshu"), "unsafe_credentials");
  });
});

describe("assertNoHttpsDowngrade", () => {
  it("rejects HTTPS to HTTP", () => {
    expectCode(
      () => assertNoHttpsDowngrade(new URL("https://example.com"), new URL("http://example.com")),
      "https_downgrade"
    );
  });
});
