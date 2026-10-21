import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTaskManager, type BrowserAuthority, type BrowserDocument, type BrowserEngine, type BrowserPage } from "./task-manager";
import { type BrowserGrant, MAX_BODY_BYTES } from "./contracts";

const token = "opaque-collection-grant-01234567890123456789";
const grant: BrowserGrant = {
  grant_id: "11111111-1111-4111-8111-111111111111",
  account_id: "22222222-2222-4222-8222-222222222222",
  collection_id: "33333333-3333-4333-8333-333333333333",
  source_revision: "a".repeat(64), source_url: "https://mp.weixin.qq.com/s/example", expires_at: 1_800_000,
};
const article: BrowserDocument = { url: grant.source_url, title: "真实文章标题", text: "文章正文".repeat(100), verificationRequired: false, complete: true };
const managers: BrowserTaskManager[] = [];
function setup(timeout = 1000) {
  let now = 1000;
  const authority: BrowserAuthority = { resolve: vi.fn(async () => ({ ...grant })) };
  const page: BrowserPage = { read: vi.fn(async () => ({ ...article })), scroll: vi.fn(async () => {}), show: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const engine: BrowserEngine = { open: vi.fn(async () => page), close: vi.fn(async () => {}) };
  const manager = new BrowserTaskManager(authority, engine, () => now, timeout);
  managers.push(manager);
  return { manager, authority, page, engine, setNow: (value: number) => { now = value; } };
}
async function opened(manager: BrowserTaskManager) { return { task_id: (await manager.open({ grant: token })).task_id }; }
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.shutdown())); });

describe("dedicated browser task authority and evidence", () => {
  it("returns fresh private evidence but never includes evidence in status", async () => {
    const { manager, page } = setup(); const input = await opened(manager);
    expect(await manager.status(input)).toMatchObject({ status: "opened", read_count: 0 });
    expect(page.read).not.toHaveBeenCalled();
    expect(await manager.read(input)).toMatchObject({ status: "ready", read_count: 1,
      evidence: { title: article.title, text: article.text, visibility: "account_private", complete: true } });
    expect(await manager.status(input)).not.toHaveProperty("evidence");
  });
  it("verification never exposes challenge content and explicit retry reads again", async () => {
    const { manager, page } = setup(); const input = await opened(manager);
    vi.mocked(page.read).mockResolvedValueOnce({ ...article, url: "https://mp.weixin.qq.com/verify?token=secret", verificationRequired: true, text: "验证码 secret" });
    const result = await manager.read(input);
    expect(result).toMatchObject({ status: "needs_user_verification", read_count: 1 });
    expect(JSON.stringify(result)).not.toMatch(/secret|验证码/);
    await manager.status(input); await manager.interact(input, "show");
    expect(page.read).toHaveBeenCalledTimes(1);
    expect(await manager.read(input)).toMatchObject({ status: "ready", read_count: 2 });
  });
  it("does not let invalid input or rejected grant evict a live page", async () => {
    const { manager, authority, page } = setup(); await opened(manager);
    await expect(manager.open({ grant: token, url: "file:///etc/passwd" })).rejects.toMatchObject({ code: "invalid_request" });
    vi.mocked(authority.resolve).mockRejectedValueOnce(new Error("secret"));
    await expect(manager.open({ grant: token })).rejects.toMatchObject({ code: "permission_revoked" });
    expect(page.close).not.toHaveBeenCalled();
  });
  it.each(["account_id", "source_revision", "collection_id"] as const)("rechecks %s after extraction and discards stale evidence", async field => {
    const { manager, authority, page } = setup(); const input = await opened(manager);
    vi.mocked(page.read).mockImplementation(async () => {
      vi.mocked(authority.resolve).mockResolvedValue({ ...grant, [field]: field === "source_revision" ? "b".repeat(64) : "44444444-4444-4444-8444-444444444444" });
      return article;
    });
    await expect(manager.read(input)).rejects.toMatchObject({ code: "source_changed" });
    expect(page.close).toHaveBeenCalledTimes(1);
    await expect(manager.status(input)).rejects.toMatchObject({ code: "task_not_found" });
  });
  it("expires tasks and does not trust a grant refresh to extend lifetime", async () => {
    const { manager, setNow, page } = setup(); const input = await opened(manager);
    setNow(grant.expires_at);
    await expect(manager.read(input)).rejects.toMatchObject({ code: "task_expired" });
    expect(page.read).not.toHaveBeenCalled(); expect(page.close).toHaveBeenCalled();
  });
  it("cancellation interrupts stuck reads and rejects late results", async () => {
    const { manager, page } = setup(); const input = await opened(manager);
    let finish!: (doc: BrowserDocument) => void;
    vi.mocked(page.read).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const read = manager.read(input); const assertion = expect(read).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(page.read).toHaveBeenCalled());
    await expect(manager.status(input)).rejects.toMatchObject({ code: "browser_busy" });
    expect(await manager.close(input)).toMatchObject({ status: "closed" });
    finish(article); await assertion;
    await expect(manager.status(input)).rejects.toMatchObject({ code: "task_not_found" });
  });
  it("times out an uncooperative page and invalidates its task", async () => {
    const { manager, page } = setup(20); const input = await opened(manager);
    vi.mocked(page.read).mockImplementation(() => new Promise(() => {}));
    await expect(manager.read(input)).rejects.toMatchObject({ code: "browser_timeout" });
    expect(page.close).toHaveBeenCalled();
  });
  it("cleans up pages that finish opening after timeout", async () => {
    const { manager, engine, page } = setup(20);
    let finish!: (page: BrowserPage) => void;
    vi.mocked(engine.open).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await expect(manager.open({ grant: token })).rejects.toMatchObject({ code: "browser_timeout" });
    finish(page); await vi.waitFor(() => expect(page.close).toHaveBeenCalled());
  });
  it("duplicate open reuses a task without navigating or extending expiration", async () => {
    const { manager, engine, setNow } = setup(); const result = await manager.open({ grant: token });
    setNow(5000);
    expect(await manager.open({ grant: token })).toEqual(result);
    expect(engine.open).toHaveBeenCalledTimes(1);
  });
  it("rejects evidence from an unexpected URL", async () => {
    const { manager, page } = setup(); const input = await opened(manager);
    vi.mocked(page.read).mockResolvedValue({ ...article, url: "http://127.0.0.1/secret" });
    await expect(manager.read(input)).rejects.toMatchObject({ code: "unsafe_source" });
  });
  it("does not label partial or oversized evidence ready", async () => {
    const { manager, page } = setup(); const input = await opened(manager);
    vi.mocked(page.read).mockResolvedValueOnce({ ...article, complete: false });
    expect(await manager.read(input)).toMatchObject({ status: "incomplete", evidence: { complete: false } });
    vi.mocked(page.read).mockResolvedValueOnce({ ...article, text: "中".repeat(MAX_BODY_BYTES / 2) });
    expect(await manager.read(input)).toMatchObject({ status: "incomplete" });
    vi.mocked(page.read).mockResolvedValueOnce({ ...article, text: "" });
    expect(await manager.read(input)).not.toHaveProperty("evidence");
  });
  it("shutting down rejects all later operations", async () => {
    const { manager } = setup(); await manager.shutdown();
    await expect(manager.open({ grant: token })).rejects.toMatchObject({ code: "browser_unavailable" });
  });
});
