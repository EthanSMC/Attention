import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("workspace reader build configuration", () => {
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
