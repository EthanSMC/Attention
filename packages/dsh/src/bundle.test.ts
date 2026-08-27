import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("DSH plugin bundle", () => {
  it("publishes the official Cordis patch bundle contract", () => {
    expect(packageJson).toMatchObject({
      dsh: {
        bundle: {
          patch: "./cordis.patch.yml",
        },
      },
      files: ["README.md", "SKILL.md", "cordis.patch.yml"],
      private: false,
      publishConfig: {
        access: "public",
      },
    });
  });

  it("delegates MCP transport to the official DSH MCP client", () => {
    const patch = readFileSync(
      new URL("../cordis.patch.yml", import.meta.url),
      "utf8",
    );

    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain("serverName: attention");
    expect(patch).toContain("transport: streamable-http");
    expect(patch).toContain("process.env.ATTENTION_MCP_URL");
    expect(patch).toContain("process.env.ATTENTION_API_KEY");
    expect(patch).not.toContain("attention-channel");
    expect(patch).not.toContain("runtime-reporter");
  });
});
