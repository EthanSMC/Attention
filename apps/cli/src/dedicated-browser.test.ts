import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureDedicatedBrowser, loadDedicatedBrowser, disableDedicatedBrowser, browserPermissionFingerprint } from "./dedicated-browser";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "attention-browser-consent-")); roots.push(home);
  const pkg = join(home, "browser-agent"); await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@attention/browser-agent", version: "0.1.0",
    dependencies: { playwright: "1.62.0", "@modelcontextprotocol/sdk": "1.30.0", zod: "4.4.3" } }));
  const entryPath = join(pkg, "dist/stdio.js"); await writeFile(entryPath, "// pinned browser fixture");
  return { home, entryPath, origin: "https://attention.example" };
}
it("does not enable on dry run, pins explicit consent, and preserves profile on disable", async () => {
  const f = await fixture();
  expect(await configureDedicatedBrowser({ ...f, apply: false })).toMatchObject({ applied: false });
  expect(await loadDedicatedBrowser(f.origin, f.home)).toBeUndefined();
  await configureDedicatedBrowser({ ...f, apply: true });
  const config = await loadDedicatedBrowser(f.origin, f.home);
  expect(config).toMatchObject({ consentVersion: 1, origin: f.origin });
  expect(browserPermissionFingerprint(config!)).toMatch(/^[a-f0-9]{64}$/);
  const marker = join(f.home, ".attention/browser/retained-profile-marker"); await writeFile(marker, "keep");
  await disableDedicatedBrowser(f.home);
  expect(await loadDedicatedBrowser(f.origin, f.home)).toBeUndefined();
  expect(await readFile(marker, "utf8")).toBe("keep");
});
it("rejects a changed artifact, wrong issuer and broadly readable receipt", async () => {
  const f = await fixture(); await configureDedicatedBrowser({ ...f, apply: true });
  await expect(loadDedicatedBrowser("https://other.example", f.home)).rejects.toThrow("browser_consent_invalid");
  await writeFile(f.entryPath, "// changed code");
  await expect(loadDedicatedBrowser(f.origin, f.home)).rejects.toThrow("browser_reconsent_required");
  await configureDedicatedBrowser({ ...f, apply: true });
  await chmod(join(f.home, ".attention/browser/consent.json"), 0o644);
  await expect(loadDedicatedBrowser(f.origin, f.home)).rejects.toThrow("browser_configuration_permissions");
});
