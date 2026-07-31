import { describe, expect, it } from "vitest";

import { createApp } from "./index.js";

const secret = "test-fetcher-secret-that-is-long-enough";

describe("fetcher API", () => {
  it("requires the shared secret", async () => {
    const response = await createApp(secret).request("/v1/fetch", {
      body: JSON.stringify({ url: "https://example.com" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });

    expect(response.status).toBe(401);
  });

  it("rejects private literal addresses without issuing a request", async () => {
    const response = await createApp(secret).request("/v1/fetch", {
      body: JSON.stringify({ url: "http://127.0.0.1/private" }),
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json"
      },
      method: "POST"
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "unsafe_address" }
    });
  });

  it("does not echo unsafe credentials", async () => {
    const response = await createApp(secret).request("/v1/fetch", {
      body: JSON.stringify({
        url: "https://example.com/?access_token=never-echo-this"
      }),
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json"
      },
      method: "POST"
    });

    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("never-echo-this");
  });
});
