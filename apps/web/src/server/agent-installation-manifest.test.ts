import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  ATTENTION_SKILL_PACKAGE_VERSION,
  ATTENTION_SKILL_DOCUMENT_SHA256,
  ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
  AgentInstallationCatalogSchema,
  AgentInstallationProfileSchema,
  RestrictedAgentProfileTemplateSchema,
  agentInstallationCatalog,
  agentInstallationProfiles,
  restrictedAgentProfileTemplate,
} from "@attention/contracts";
import { describe, expect, it } from "vitest";

import { ATTENTION_TOOL_CONTRACT_VERSION } from "./attention-tool-registry";

const publicSkillRoot = new URL(
  "../../public/skills/attention/",
  import.meta.url,
);
const repositoryRoot = new URL("../../../../", import.meta.url);
const execFileAsync = promisify(execFile);

async function readPublicFile(path: string): Promise<string> {
  return readFile(new URL(path, publicSkillRoot), "utf8");
}

async function readPublicJson(path: string): Promise<unknown> {
  return JSON.parse(await readPublicFile(path)) as unknown;
}

describe("public Agent installation artifacts", () => {
  it("keeps the public catalog and host manifests synchronized with contracts", async () => {
    const catalog = AgentInstallationCatalogSchema.parse(
      await readPublicJson("installations/v1/index.json"),
    );
    expect(catalog).toEqual(agentInstallationCatalog);

    const profiles = await Promise.all(
      catalog.integrations.map(async ({ id, manifest_path: manifestPath }) => {
        const relativePath = manifestPath.replace(
          "/skills/attention/",
          "",
        );
        const profile = AgentInstallationProfileSchema.parse(
          await readPublicJson(relativePath),
        );
        expect(profile.id).toBe(id);
        return profile;
      }),
    );

    expect(profiles).toEqual(agentInstallationProfiles);
  });

  it("keeps the public restricted profile synchronized with its schema", async () => {
    const template = RestrictedAgentProfileTemplateSchema.parse(
      await readPublicJson(
        "installations/v1/templates/restricted-profile.json",
      ),
    );
    expect(template).toEqual(restrictedAgentProfileTemplate);
  });

  it("publishes a deterministic WorkBuddy ZIP with SKILL.md at the archive root", async () => {
    const profile = agentInstallationProfiles.find(
      ({ id }) => id === "workbuddy",
    );
    expect(profile?.skill).toMatchObject({
      availability: "available",
      bundle_path: ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
      bundle_sha256: ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
      bundle_skill_path: "SKILL.md",
      delivery: "host_upload_bundle",
    });

    const bundle = new URL(
      `.${ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH.replace("/skills/attention", "")}`,
      publicSkillRoot,
    );
    const bundleBytes = await readFile(bundle);
    expect(createHash("sha256").update(bundleBytes).digest("hex")).toBe(
      ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
    );

    const { stdout: entries } = await execFileAsync("unzip", [
      "-Z1",
      bundle.pathname,
    ]);
    expect(entries.trim().split("\n")).toEqual(["SKILL.md"]);
    const { stdout: archivedSkill } = await execFileAsync("unzip", [
      "-p",
      bundle.pathname,
      "SKILL.md",
    ]);
    expect(archivedSkill).toBe(await readPublicFile("SKILL.md"));

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "attention-workbuddy-bundle-test-"),
    );
    try {
      const rebuilt = join(temporaryDirectory, "rebuilt.zip");
      await execFileAsync("bash", [
        new URL(
          "scripts/build-workbuddy-skill-bundle.sh",
          repositoryRoot,
        ).pathname,
        rebuilt,
      ]);
      expect(await readFile(rebuilt)).toEqual(bundleBytes);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("binds the install manifest, Skill, and Tool Registry versions", async () => {
    const skill = await readPublicFile("SKILL.md");

    expect(createHash("sha256").update(skill).digest("hex")).toBe(
      ATTENTION_SKILL_DOCUMENT_SHA256,
    );
    expect(agentInstallationCatalog.skill.document_sha256).toBe(
      ATTENTION_SKILL_DOCUMENT_SHA256,
    );
    expect(ATTENTION_SKILL_PACKAGE_VERSION).toBe("1.6.0");
    expect(ATTENTION_SKILL_TOOL_CONTRACT_VERSION).toBe("1.4.0");
    expect(ATTENTION_TOOL_CONTRACT_VERSION).toBe(
      ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
    );
    expect(skill).toContain(
      `Skill version: \`${ATTENTION_SKILL_PACKAGE_VERSION}\``,
    );
    expect(skill).toContain(
      `Tool contract version: \`${ATTENTION_SKILL_TOOL_CONTRACT_VERSION}\``,
    );
    expect(skill).toContain(
      "Installation manifest: `/skills/attention/installations/v1/index.json`",
    );
    expect(skill).toContain(
      "Installation guide: `/skills/attention/INSTALL.md`",
    );
  });

  it("states the v1 non-hosted boundary in the public install guide", async () => {
    const guide = await readPublicFile("INSTALL.md");

    expect(guide).toMatch(/does \*\*not\*\* provide a Hosted Agent/u);
    expect(guide).toMatch(/Hosted Channel UI/u);
    expect(guide).toMatch(/visible Desktop conversation/u);
    expect(guide).toMatch(/WorkBuddy[\s\S]*no\s+Runtime OAuth client/u);
    expect(guide).toMatch(/WorkBuddy[\s\S]*no supported channel-binding status API/u);
    expect(guide).toMatch(/~\/\.agents\/skills\/attention\/SKILL\.md/u);
    expect(guide).toMatch(/~\/\.claude\/skills\/attention\/SKILL\.md/u);
    expect(guide).toMatch(/schema:\s*`2\.3\.0`[\s\S]*six separate/u);
    expect(guide).toMatch(/## Schema 2\.2 migration[\s\S]*mcp\.setup_mode/u);
    expect(guide).toMatch(/iLink token[\s\S]*remain\s+local/u);
  });
});
