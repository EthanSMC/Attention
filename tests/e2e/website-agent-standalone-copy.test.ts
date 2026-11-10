import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertStandaloneLinksContained, copyWebsiteStandalone } from "./fixtures/website-agent-standalone-copy";
import productionConfig from "./website-agent-production.playwright.config";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "attention-standalone-copy-test-"));
  temporary.push(root);
  const standalone = join(root, "source");
  const staticFiles = join(root, "static");
  const publicFiles = join(root, "public");
  const destination = join(root, "relocated");
  const nextPackage = join(standalone, "node_modules/.pnpm/next@fixture/node_modules/next");
  const helperPackage = join(standalone, "node_modules/.pnpm/helper@fixture/node_modules/helper");
  for (const directory of [nextPackage, helperPackage, join(standalone, "apps/web/node_modules"), staticFiles, publicFiles])
    await mkdir(directory, { recursive: true });
  await writeFile(join(nextPackage, "index.cjs"), 'module.exports = require("helper");\n');
  await writeFile(join(helperPackage, "package.json"), JSON.stringify({ name: "helper", main: "index.cjs" }));
  await writeFile(join(helperPackage, "index.cjs"), 'module.exports = "resolved from traced sibling";\n');
  await symlink("../../helper@fixture/node_modules/helper", join(dirname(nextPackage), "helper"));
  await symlink("../../../node_modules/.pnpm/next@fixture/node_modules/next", join(standalone, "apps/web/node_modules/next"));
  await writeFile(join(staticFiles, "app.js"), "synthetic static asset");
  await writeFile(join(publicFiles, "icon.svg"), "synthetic public asset");
  return { root, standalone, staticFiles, publicFiles, destination };
}

describe("standalone relocation retains the production package layout", () => {
  it("preserves relative pnpm links, resolves sibling dependencies, and copies real asset locations", async () => {
    const paths = await fixture();
    await copyWebsiteStandalone(paths);
    const link = join(paths.destination, "apps/web/node_modules/next");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe("../../../node_modules/.pnpm/next@fixture/node_modules/next");
    const entry = await realpath(join(link, "index.cjs"));
    const require = createRequire(entry);
    expect(require.resolve("helper").startsWith(paths.destination)).toBe(true);
    expect(require(entry)).toBe("resolved from traced sibling");
    expect(await readFile(join(paths.destination, "apps/web/.next/static/app.js"), "utf8")).toBe("synthetic static asset");
    expect(await readFile(join(paths.destination, "apps/web/public/icon.svg"), "utf8")).toBe("synthetic public asset");
    await expect(assertStandaloneLinksContained(paths.destination)).resolves.toBeUndefined();
  });
  it("reproduces why dereferencing the same layout loses its sibling dependencies", async () => {
    const paths = await fixture();
    await cp(paths.standalone, paths.destination, { recursive: true, dereference: true });
    const entry = await realpath(join(paths.destination, "apps/web/node_modules/next/index.cjs"));
    expect(() => createRequire(entry).resolve("helper")).toThrow("Cannot find module");
  });
  it("excludes dotenv and private configuration from every copied input", async () => {
    const paths = await fixture();
    for (const directory of [paths.standalone, paths.staticFiles, paths.publicFiles]) {
      for (const file of [".env", ".env.production", ".npmrc", ".netrc"]) await writeFile(join(directory, file), "synthetic excluded value");
      await mkdir(join(directory, ".git"));
      await writeFile(join(directory, ".git/config"), "synthetic excluded config");
    }
    await copyWebsiteStandalone(paths);
    for (const directory of [paths.destination, join(paths.destination, "apps/web/.next/static"), join(paths.destination, "apps/web/public")]) {
      for (const file of [".env", ".env.production", ".npmrc", ".netrc", ".git"])
        await expect(lstat(join(directory, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("rejects even an in-tree absolute symlink instead of keeping a source-tree reference", async () => {
    const paths = await fixture();
    await symlink(join(paths.standalone, "node_modules"), join(paths.standalone, "absolute"));
    await expect(copyWebsiteStandalone(paths)).rejects.toThrow("Unsafe standalone symlink");
    await expect(lstat(paths.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an escaping symlink before copying any host file", async () => {
    const paths = await fixture();
    await writeFile(join(paths.root, "outside.txt"), "synthetic outside target");
    await symlink("../outside.txt", join(paths.standalone, "escape"));
    await expect(copyWebsiteStandalone(paths)).rejects.toThrow("Unsafe standalone symlink");
    await expect(lstat(paths.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a relative alias that ultimately resolves outside its package", async () => {
    const paths = await fixture();
    await writeFile(join(paths.root, "outside.txt"), "synthetic outside target");
    await symlink("../outside.txt", join(paths.standalone, "outer"));
    await symlink("outer", join(paths.standalone, "alias"));
    await expect(copyWebsiteStandalone(paths)).rejects.toThrow("symlink");
  });
  it("rejects a benign-looking symlink to an excluded dotenv file", async () => {
    const paths = await fixture();
    await writeFile(join(paths.standalone, ".env.production"), "synthetic excluded value");
    await symlink(".env.production", join(paths.standalone, "environment-alias"));
    await expect(copyWebsiteStandalone(paths)).rejects.toThrow("Unsafe standalone symlink");
  });
  it("validates static/public input links before beginning the standalone copy", async () => {
    const paths = await fixture();
    await writeFile(join(paths.root, "outside.txt"), "synthetic outside target");
    await symlink("../outside.txt", join(paths.publicFiles, "escape"));
    await expect(copyWebsiteStandalone(paths)).rejects.toThrow("Unsafe standalone symlink");
    await expect(lstat(paths.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves the original setup failure instead of rerunning migration in a replacement worker", () => {
    expect(productionConfig).toMatchObject({ workers: 1, retries: 0, maxFailures: 1,
      use: { launchOptions: { chromiumSandbox: true }, trace: "off" } });
  });
});
