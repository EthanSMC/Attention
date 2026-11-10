import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ATTENTION_CLI_VERSION } from "../apps/cli/src/version.js";
import { dynamic, GET, runtime } from "../apps/web/src/app/api/health/route.js";
import release from "../release.json";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const sha256 = (path: string) => createHash("sha256")
  .update(readFileSync(new URL(path, root)))
  .digest("hex");

const migrations = [
  {
    idx: 38,
    tag: "0038_source_read_coordination",
    sha256: "51df66457e24edb2b5971b8adf3ce5fa530b6505fdd4bfde9b01396c5f1ed926",
  },
  {
    idx: 39,
    tag: "0039_website_agent_budget",
    sha256: "1b2782bb7d768ac256fdd2139d459009c206218b6e7f604926d48077b1bf3412",
  },
  {
    idx: 40,
    tag: "0040_website_agent_sessions",
    sha256: "2ac6cf38ba72d8a1e1ae3d1e67861f0cc149297963a82051c3d23dc0e5f504ca",
  },
];

describe("Attention application release identity", () => {
  it("keeps the root package consistent with the canonical RC metadata", () => {
    const packageJson = JSON.parse(read("package.json")) as { version: string };

    expect(release).toEqual({ version: "0.3.23-rc.1" });
    expect(packageJson.version).toBe(release.version);
  });

  it("exposes only liveness and the bundled application version", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", version: release.version });
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
  });

  it("preserves the separate deployed CLI/runtime identity and artifact bytes", () => {
    const cliPackage = JSON.parse(read("apps/cli/package.json")) as { version: string };
    const manifest = JSON.parse(read("apps/web/public/cli/manifest.json")) as {
      artifact_path: string;
      sha256: string;
      version: string;
    };

    expect(ATTENTION_CLI_VERSION).toBe("0.3.21");
    expect(cliPackage.version).toBe(ATTENTION_CLI_VERSION);
    expect(manifest.version).toBe(ATTENTION_CLI_VERSION);
    expect(manifest.artifact_path).toBe("/cli/attention-0.3.21.mjs");
    expect(manifest.sha256).toBe("47ec8b0f7b7921d13979400a8b14a712301e737a4291ae91e3ceef1ae9052117");
    expect(sha256(`apps/web/public${manifest.artifact_path}`)).toBe(manifest.sha256);
    expect(sha256("apps/web/public/cli/manifest.json"))
      .toBe("cde7c6161d62467826cde49ac221cb1ab5fec1f728157f7bd0fc3099b9048dec");
  });

  it("preserves the independently versioned Skill and tool contract", () => {
    const skill = read("apps/web/public/skills/attention/SKILL.md");

    expect(skill).toContain("Skill version: `1.10.0`");
    expect(skill).toContain("Tool contract version: `1.7.0`");
    expect(read("packages/contracts/src/attention-capability-manifest.ts"))
      .toContain('ATTENTION_MCP_TOOL_CONTRACT_VERSION = "1.7.0"');
  });

  it("records the ordered 0038 → 0039 budget → 0040 sessions schema path", () => {
    const journal = JSON.parse(read("packages/db/drizzle/meta/_journal.json")) as {
      entries: { idx: number; tag: string }[];
    };

    expect(journal.entries.slice(-3).map(({ idx, tag }) => ({ idx, tag })))
      .toEqual(migrations.map(({ idx, tag }) => ({ idx, tag })));
  });

  it.each(migrations)("pins $tag SQL bytes and their deployment mapping", (migration) => {
    expect(sha256(`packages/db/drizzle/${migration.tag}.sql`)).toBe(migration.sha256);
    const mapping = read("docs/releases/2026-11-10-application-deployment-mapping.md");
    expect(mapping).toContain(migration.tag);
    expect(mapping).toContain(migration.sha256);
  });
});
