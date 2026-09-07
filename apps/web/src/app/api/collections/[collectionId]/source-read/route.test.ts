import {describe, expect, it, vi} from "vitest";

describe("session source-read route", () => {
  it("exports only supported Next route entry points and configuration", async () => {
    expect(Object.keys(await import("./route")).sort()).toEqual(["POST", "dynamic", "runtime"]);
  });
  it("rejects cross-origin and unauthenticated callers without resolving collection or reading", async () => {
    const route = await import("../../../../../server/collection-source-read-route").catch(() => undefined);
    expect(route).toBeDefined();
    const resolve = vi.fn(async () => null), getDatabase = vi.fn();
    const id = "00000000-0000-4000-8000-000000000001";
    const external = new Request(`https://attention.test/api/collections/${id}/source-read`, {method: "POST",
      headers: {origin: "https://elsewhere.test", "content-type": "application/json"}, body: JSON.stringify({attempt_ref: "a"})});
    expect((await route!.handleSourceReadRequest(external, id, {resolve, getDatabase})).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    const local = new Request(external.url, {method: "POST", headers: {origin: "https://attention.test"}, body: "{}"});
    const response = await route!.handleSourceReadRequest(local, id, {resolve, getDatabase});
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getDatabase).not.toHaveBeenCalled();
  });
});
