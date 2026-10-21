import { describe, expect, it, vi } from "vitest";
import { HttpBrowserAuthority } from "./http-authority";

const account = "22222222-2222-4222-8222-222222222222";
const grant = { grant_id: "11111111-1111-4111-8111-111111111111", account_id: account,
  collection_id: "33333333-3333-4333-8333-333333333333", source_revision: "a".repeat(64),
  source_url: "https://mp.weixin.qq.com/s/example", expires_at: 1_800_000 };
describe("browser grant resolution", () => {
  it("pins service origin and never follows redirects with a bearer grant", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(grant));
    const authority = new HttpBrowserAuthority("https://attention.example", account, fetcher);
    expect(await authority.resolve("opaque", new AbortController().signal)).toEqual(grant);
    expect(fetcher).toHaveBeenCalledWith("https://attention.example/api/browser/grants/resolve",
      expect.objectContaining({ method: "POST", redirect: "error", body: "{}" }));
  });
  it("does not accept a valid grant belonging to a different local owner", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...grant, account_id: grant.collection_id }));
    await expect(new HttpBrowserAuthority("https://attention.example", account, fetcher).resolve("opaque", new AbortController().signal))
      .rejects.toMatchObject({ code: "permission_revoked" });
  });
  it("rejects oversized responses and invalid grants", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(9000)));
    await expect(new HttpBrowserAuthority("https://attention.example", account, fetcher).resolve("opaque", new AbortController().signal))
      .rejects.toMatchObject({ code: "permission_revoked" });
  });
  it.each(["http://attention.example", "https://user:pw@attention.example", "https://attention.example/other", "https://attention.example?x=1"])("rejects unsafe configured issuer %s", origin => {
    expect(() => new HttpBrowserAuthority(origin, account)).toThrow();
  });
});
