import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("workspace reader build configuration", () => {
  it("uses the verified webpack resolver in the production build entrypoint", () => {
    const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(manifest.scripts.build).toBe("next build --webpack");
  });

  it("resolves Node-style JavaScript specifiers to uncompiled workspace TypeScript", () => {
    expect(config.experimental?.extensionAlias).toEqual({ ".js": [".ts", ".tsx", ".js"] });
    expect(config.transpilePackages).toEqual(expect.arrayContaining([
      "@attention/content-reader", "@attention/content-reader-contracts", "@attention/fetcher",
    ]));
  });

  it("retains the workspace-only standalone tracing boundary", () => {
    expect(config.output).toBe("standalone");
    expect(config.outputFileTracingRoot).toBe(fileURLToPath(new URL("../..", import.meta.url)));
    expect(config.poweredByHeader).toBe(false);
  });
});
