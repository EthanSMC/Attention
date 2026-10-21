import { mkdtemp, chmod, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AccountBoundAuthority } from "./account-authority";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "attention-browser-binding-")); roots.push(root);
  const grant = { grant_id: "11111111-1111-4111-8111-111111111111", account_id: "22222222-2222-4222-8222-222222222222",
    collection_id: "33333333-3333-4333-8333-333333333333", source_url: "https://mp.weixin.qq.com/s/test",
    source_revision: "a".repeat(64), expires_at: Date.now() + 60_000 };
  const remote = { resolve: vi.fn(async () => grant) };
  return { root, grant, remote, authority: new AccountBoundAuthority(remote, "https://attention.example", root), signal: new AbortController().signal };
}
it("persists only validated identity, never the grant, and rejects switched accounts/issuers", async () => {
  const { root, grant, remote, authority, signal } = await fixture();
  await authority.resolve("opaque-secret", signal);
  expect(await readFile(join(root, "browser/account-binding.json"), "utf8")).not.toContain("opaque-secret");
  await expect(new AccountBoundAuthority(remote, "https://other.example", root).resolve("new-secret", signal))
    .rejects.toMatchObject({ code: "permission_revoked" });
  remote.resolve.mockResolvedValue({ ...grant, account_id: "44444444-4444-4444-8444-444444444444" });
  await expect(authority.resolve("new-secret", signal)).rejects.toMatchObject({ code: "permission_revoked" });
});
it("does not bind a rejected or expired grant", async () => {
  const { root, remote, grant, authority, signal } = await fixture();
  remote.resolve.mockRejectedValueOnce(new Error("permission_revoked"));
  await expect(authority.resolve("secret", signal)).rejects.toThrow();
  remote.resolve.mockResolvedValue({ ...grant, expires_at: Date.now() - 1 });
  await expect(authority.resolve("secret", signal)).rejects.toMatchObject({ code: "task_expired" });
  await expect(readFile(join(root, "browser/account-binding.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects permissive directories, symlink roots and permissive binding files", async () => {
  const { root, remote, authority, signal } = await fixture();
  await chmod(root, 0o755);
  await expect(authority.resolve("secret", signal)).rejects.toMatchObject({ code: "browser_unavailable" });
  await chmod(root, 0o700);
  await symlink(root, join(root, "linked-root"));
  await expect(new AccountBoundAuthority(remote, "https://attention.example", join(root, "linked-root")).resolve("secret", signal)).rejects.toThrow();
  await authority.resolve("secret", signal);
  await chmod(join(root, "browser/account-binding.json"), 0o644);
  await expect(authority.resolve("secret", signal)).rejects.toMatchObject({ code: "permission_revoked" });
});
