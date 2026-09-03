import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("published Attention CLI artifact", () => {
  it("keeps package, runtime, manifest, artifact filename, and hash aligned", async () => {
    const [packageJson, versionSource, manifestJson] = await Promise.all([
      readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
      readFile(new URL("../apps/cli/src/version.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../apps/web/public/cli/manifest.json", import.meta.url),
        "utf8",
      ),
    ]);
    const packageVersion = (JSON.parse(packageJson) as { version: string })
      .version;
    const manifest = JSON.parse(manifestJson) as {
      artifact_path: string;
      sha256: string;
      version: string;
    };
    const runtimeVersion = versionSource.match(
      /ATTENTION_CLI_VERSION\s*=\s*"([^"]+)"/u,
    )?.[1];
    const artifact = await readFile(
      new URL(`../apps/web/public${manifest.artifact_path}`, import.meta.url),
    );

    expect(runtimeVersion).toBe(packageVersion);
    expect(manifest.version).toBe(packageVersion);
    expect(manifest.artifact_path).toBe(
      `/cli/attention-${packageVersion}.mjs`,
    );
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(
      manifest.sha256,
    );
  });

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
