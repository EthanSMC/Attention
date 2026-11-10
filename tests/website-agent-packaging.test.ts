import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import nextConfig from "../apps/web/next.config";

const root = resolve(import.meta.dirname, "..");
const nativePackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;

function dependencies(path: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")).dependencies;
}

describe("website agent production packaging", () => {
  it("keeps Pi's Node loaders native while transpiling the workspace adapter", () => {
    expect(nextConfig.serverExternalPackages).toEqual(expect.arrayContaining(nativePackages));
    expect(nextConfig.serverExternalPackages).not.toContain("@attention/website-agent");
    expect(nextConfig.transpilePackages).toContain("@attention/website-agent");
    expect(nextConfig.output).toBe("standalone");
  });

  it("keeps identical published Pi packages available at both resolution roots", () => {
    const web = dependencies("apps/web/package.json");
    const adapter = dependencies("packages/website-agent/package.json");
    for (const name of nativePackages) {
      expect(web[name]).toBe("0.85.1");
      expect(web[name]).toBe(adapter[name]);
      expect(realpathSync(resolve(root, "apps/web/node_modules", name)))
        .toBe(realpathSync(resolve(root, "packages/website-agent/node_modules", name)));
    }
  });
});
