import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("published Attention CLI artifact", () => {
  it("does not embed host-specific absolute source paths", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../apps/web/public/cli/manifest.json", import.meta.url),
        "utf8",
      ),
    ) as { artifact_path: string };
    const artifact = await readFile(
      new URL(`../apps/web/public${manifest.artifact_path}`, import.meta.url),
      "utf8",
    );

    expect(artifact).not.toMatch(
      /(?:^|\n)\/\/ .*?(?:\/Users\/|\/home\/runner\/|\/private\/tmp\/)/u,
    );
  });
});
