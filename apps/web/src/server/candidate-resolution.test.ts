import { extractLinkCandidates } from "@attention/collector";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FetcherClient from "./fetcher-client";

const resolver = vi.hoisted(() => vi.fn());
vi.mock("./fetcher-client", async (original) => ({
  ...await original<typeof FetcherClient>(),
  resolveExternalUrl: resolver,
}));
import { resolveCandidate } from "./collection-service";

afterEach(() => vi.resetAllMocks());

const shortUrl = "https://xhslink.cn/o/short-note-fixture";
const note = "https://www.xiaohongshu.com/explore/6ad7f00d000000002c034c0b";
const access = `${note}?xsec_source=app_share&xsec_token=public-share-token`;
const redirectChain = ["302:xhslink.cn:synthetic-fingerprint"];
const loginUrl = (target: string) =>
  `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(target)}`;
const resolveTo = (finalUrl: string) => resolver.mockResolvedValue({ finalUrl, redirectChain });

describe("request-scoped URL resolution cancellation", () => {
  it("does not start a resolver call after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(resolveCandidate(note, { signal: controller.signal })).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });
  it("does not accept a late result or fallback after cancellation", async () => {
    const controller = new AbortController();
    resolver.mockImplementation(async () => { controller.abort(); return { finalUrl: note, redirectChain: [] }; });
    await expect(resolveCandidate(note, { signal: controller.signal })).rejects.toThrow();
    expect(resolver).toHaveBeenCalledWith(note, "xiaohongshu", { signal: controller.signal });
  });
});

describe("Xiaohongshu login redirects preserve note identity", () => {
  it("extracts Xiaohongshu shortlinks from Chinese share text", () => {
    const url = "https://xhslink.cn/o/2AbPpMockI0";
    expect(extractLinkCandidates({
      channel: "web", channel_message_id: "screenshot-fixture", parser_version: "test",
      payload_type: "text", raw_payload: `这是一篇测试分享 ${url} 存好口令，直达【小红书】瞅瞅~`,
      received_at: "2026-11-10T00:00:00.000Z", sender_account_id: "00000000-0000-4000-8000-000000000001",
    }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ url })]));
  });

  it.each([
    note,
    note.replace("https:", "http:"),
    note.replace("/explore/", "/discovery/item/"),
    note.replace("https://www.xiaohongshu.com", ""),
    note.replace("https://www.xiaohongshu.com", "http://xiaohongshu.com:80") + "/",
    note.replace("www.xiaohongshu.com", "www.xiaohongshu.com:443"),
  ])("recovers %s only as HTTPS note identity, without requesting it", async (target) => {
    resolveTo(loginUrl(`${target}?app_platform=android&xsec_source=app_share&xsec_token=public-share-token`));
    const result = await resolveCandidate(shortUrl);
    expect(result).toMatchObject({
      identity: { adapter: "xiaohongshu", normalizedUrl: note, contentType: "note" },
      outboundUrl: access,
      selectedUrl: shortUrl,
      resolutionStatus: "pending",
      redirectChain,
      aliasIdentities: [expect.objectContaining({ normalizedUrl: shortUrl, adapter: "generic_web" })],
    });
    expect(result?.observedUrl).toMatch(/^https:\/\//u);
    expect(resolver).toHaveBeenCalledExactlyOnceWith(shortUrl, "xiaohongshu");
  });

  it("retains an original direct note instead of accepting a changed login target", async () => {
    resolveTo(loginUrl("https://www.xiaohongshu.com/explore/different-note"));
    expect(await resolveCandidate(access)).toMatchObject({
      identity: { normalizedUrl: note }, outboundUrl: access,
      observedUrl: access, selectedUrl: access, resolutionStatus: "pending", redirectChain,
    });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(access, "xiaohongshu");
  });

  it.each([
    "https://example.com/explore/abc123",
    "//127.0.0.1/explore/abc123",
    "https://www.xiaohongshu.com.evil.example/explore/abc123",
    "https://user:password@www.xiaohongshu.com/explore/abc123",
    "https://www.xiaohongshu.com:8443/explore/abc123",
    "https://www.xiaohongshu.com/user/profile/abc123",
    "http://127.0.0.1/explore/abc123",
    "http://www.xiaohongshu.com:443/explore/abc123",
    "https://www.xiaohongshu.com:80/explore/abc123",
    "ftp://www.xiaohongshu.com/explore/abc123",
    "https://www.xiaohongshu.com/explore/abc123/extra",
    "https://www.xiaohongshu.com/explore/abc123%2Fextra",
    "https://[invalid/explore/abc123",
    "/explore/abc123\\tracking",
    "/explore/abc123\nignored",
    "/login", "",
  ])("does not recover an unsafe or non-note embedded target: %s", async (target) => {
    resolveTo(loginUrl(target));
    expect(await resolveCandidate(shortUrl)).toBeNull();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it.each([
    `${access}&access_token=private-token`,
    `${access}#access_token=private-token`,
    `${access.replace("https:", "http:")}&session_id=private-token`,
  ])("rejects credential-bearing embedded URLs before storage", async (target) => {
    resolveTo(loginUrl(target));
    await expect(resolveCandidate(shortUrl)).rejects.toThrow("dangerous_query");
    expect(resolver).toHaveBeenCalledOnce();
  });

  it.each([
    loginUrl(note).replace("https:", "http:"),
    loginUrl(note).replace(".com/login", ".com:80/login"),
    `${loginUrl(note)}&redirectPath=${encodeURIComponent(note)}`,
  ])("does not recover ambiguous or untrusted login URLs: %s", async (target) => {
    resolveTo(target);
    expect(await resolveCandidate(shortUrl)).toBeNull();
  });

  it.each([shortUrl, "https://www.xiaohongshu.com/login"])(
    "reports an unresolved known shortlink as pending instead of invalid: %s", async (target) => {
      resolveTo(target);
      await expect(resolveCandidate(shortUrl)).rejects.toThrow("resolution_pending");
      expect(resolver).toHaveBeenCalledOnce();
    },
  );

  it("never treats an explicitly submitted login page as a note", async () => {
    resolveTo(loginUrl(note));
    expect(await resolveCandidate(loginUrl(note))).toBeNull();
  });

  it("also reports an unresolved Douyin shortlink as pending", async () => {
    const url = "https://v.douyin.com/short-note-fixture/";
    resolveTo(url);
    await expect(resolveCandidate(url)).rejects.toMatchObject({
      message: "resolution_pending", source: "douyin",
    });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(url, "douyin");
  });

  it("keeps the existing direct-note success path", async () => {
    resolveTo(access);
    expect(await resolveCandidate(shortUrl)).toMatchObject({
      identity: { normalizedUrl: note }, outboundUrl: access, resolutionStatus: "resolved",
    });
  });
});
