import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface CliManifest {
  artifact_path: string;
  minimum_supported_version: string;
  node: string;
  permission_profile_sha256: string;
  schema_version: number;
  sha256: string;
  version: string;
}

describe("public Attention CLI artifact", () => {
  it("ships a checksum-pinned executable bundle from the public documentation origin", () => {
    const cliPackage = JSON.parse(
      readFileSync(new URL("../../../cli/package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string }; private?: boolean };
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../web/public/cli/manifest.json", import.meta.url),
        "utf8",
      ),
    ) as CliManifest;
    const artifact = readFileSync(
      new URL(`../../../web/public${manifest.artifact_path}`, import.meta.url),
    );

    expect(cliPackage.private).toBe(false);
    expect(cliPackage.engines?.node).toBe(">=22.16.0");
    expect(manifest.node).toBe(">=22.16.0");
    expect(manifest.schema_version).toBe(2);
    expect(manifest.minimum_supported_version).toBe("0.3.5");
    expect(manifest.permission_profile_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.artifact_path).toBe(
      `/cli/attention-${manifest.version}.mjs`,
    );
    expect(artifact.subarray(0, 20).toString("utf8")).toContain(
      "#!/usr/bin/env node",
    );
    expect(artifact.toString("utf8")).not.toMatch(/[ \t]+$/mu);
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(
      manifest.sha256,
    );
  });

  it("documents verified installation for POSIX and Windows before configure", () => {
    const install = readFileSync(
      new URL("../../public/skills/attention/INSTALL.md", import.meta.url),
      "utf8",
    );

    expect(install).toContain("/cli/manifest.json");
    expect(install).toContain("macOS / Linux");
    expect(install).toContain("Windows PowerShell");
    expect(install).toContain("SHA-256");
    expect(install.indexOf("Install the Attention CLI")).toBeLessThan(
      install.indexOf("## Codex"),
    );
  });
});
