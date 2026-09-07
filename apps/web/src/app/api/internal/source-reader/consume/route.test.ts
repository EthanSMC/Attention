import {afterEach, describe, expect, it, vi} from "vitest";
afterEach(() => vi.unstubAllEnvs());
describe("server-only reader admission routes", () => {
  it("fails closed without fixed server credentials and rejects body-supplied authority", async () => {
    const route = await import("./route").catch(() => undefined);
    expect(route).toBeDefined();
    vi.stubEnv("ATTENTION_READER_COORDINATOR_SECRET", "s".repeat(32));
    const url = "https://attention.test/api/internal/source-reader/consume";
    expect((await route!.POST(new Request(url, {method: "POST", body: "{}"}))).status).toBe(401);
    expect((await route!.POST(new Request(url, {method: "POST", headers: {authorization: `Bearer ${"s".repeat(32)}`},
      body: JSON.stringify({account_id: "arbitrary", url: "https://example.test"})}))).status).toBe(400);
  });
});
