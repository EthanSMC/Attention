import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "../../apps/web/node_modules/next/server";
import { mutationRequestError } from "../../apps/web/src/server/api-guard";
import { readJsonRequestWithinLimit } from "../../apps/web/src/server/request-body";
import { productionOrigin, productionResponseDiagnostic } from "./fixtures/website-agent-production-http";

function request(origin: string, headers: Record<string, string> = {}, body = "{}") {
  return new NextRequest(`${origin}/api/website-agent/sessions`, { method: "POST", body,
    headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers } });
}

describe("production fixture uses Next's real canonical loopback origin", () => {
  beforeEach(() => {
    // Mirror CI's configured public origin, not an origin exception for this fixture.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://attention.example.test");
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("reproduces the numeric-loopback mismatch with actual NextRequest and the unchanged CSRF guard", () => {
    const input = request("http://127.0.0.1:4179");
    expect(new URL(input.url).origin).toBe("http://localhost:4179");
    expect(input.headers.get("origin")).toBe("http://127.0.0.1:4179");
    expect(mutationRequestError(input, { maxContentLengthBytes: 4096 })).toBe("cross_origin_request");
  });
  it("accepts the canonical same-origin client and parses its real empty JSON body", async () => {
    const input = request(productionOrigin);
    expect(productionOrigin).toBe("http://localhost:4179");
    expect(new URL(input.url).origin).toBe(input.headers.get("origin"));
    expect(mutationRequestError(input, { maxContentLengthBytes: 4096 })).toBeNull();
    expect(await readJsonRequestWithinLimit(input, 4096)).toEqual({});
  });
  it("still rejects a foreign Origin", () => {
    expect(mutationRequestError(request(productionOrigin, { origin: "https://foreign.example.test" })))
      .toBe("cross_origin_request");
  });
  it("still rejects cross-site fetch metadata even with the canonical Origin", () => {
    expect(mutationRequestError(request(productionOrigin, { "sec-fetch-site": "cross-site" })))
      .toBe("cross_origin_request");
  });
  it("still enforces the production create-body length limit", () => {
    expect(mutationRequestError(request(productionOrigin, { "content-length": "4097" }), { maxContentLengthBytes: 4096 }))
      .toBe("request_too_large");
  });
  it("still rejects malformed JSON with the actual production body parser", async () => {
    await expect(readJsonRequestWithinLimit(request(productionOrigin, {}, "not-json"), 4096))
      .rejects.toThrow("invalid_request_body");
  });
});

describe("production failure diagnostics disclose only allowlisted codes", () => {
  it.each(["cross_origin_request", "invalid_request"])("identifies %s without including any other response field", async code => {
    expect(await productionResponseDiagnostic(400, async () => ({ error: { code, message: "synthetic-private-message" },
      cookie: "synthetic-cookie", token: "synthetic-token", session: { native: "synthetic-private-state" } })))
      .toBe(`HTTP 400; error=${code}`);
  });
  it("does not disclose an unrecognized error code", async () => {
    expect(await productionResponseDiagnostic(500, async () => ({ error: { code: "synthetic-private-token-in-code" } })))
      .toBe("HTTP 500; error=unrecognized_error");
  });
  it("does not disclose arbitrary non-error JSON", async () => {
    expect(await productionResponseDiagnostic(400, async () => ({ private: "synthetic-private-state" })))
      .toBe("HTTP 400; error=unrecognized_error");
  });
  it("handles non-object JSON without disclosure", async () => {
    expect(await productionResponseDiagnostic(400, async () => "synthetic-private-state"))
      .toBe("HTTP 400; error=unrecognized_error");
  });
  it("does not print body-parser failures or non-JSON response content", async () => {
    expect(await productionResponseDiagnostic(502, async () => { throw new Error("synthetic-private-body"); }))
      .toBe("HTTP 502; error=unreadable_error");
  });
  it("does not read a successful response body at all", async () => {
    const readJson = vi.fn();
    expect(await productionResponseDiagnostic(201, readJson)).toBe("HTTP 201");
    expect(readJson).not.toHaveBeenCalled();
  });
});
