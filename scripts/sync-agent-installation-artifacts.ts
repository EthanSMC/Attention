import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  ATTENTION_SKILL_DOCUMENT_SHA256,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
  agentInstallationCatalog,
  agentInstallationProfiles,
  restrictedAgentProfileTemplate,
} from "../packages/contracts/src/agent-installation.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = join(
  repositoryRoot,
  "apps/web/public/skills/attention/installations/v1",
);
const checkOnly = process.argv.includes("--check");
const execFileAsync = promisify(execFile);
const publicSkillPath = join(
  repositoryRoot,
  "apps/web/public/skills/attention/SKILL.md",
);

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const artifacts = new Map<string, string>([
  [join(publicRoot, "index.json"), json(agentInstallationCatalog)],
  ...agentInstallationProfiles.map(
    (profile) =>
      [
        join(publicRoot, "agents", `${profile.id}.json`),
        json(profile),
      ] as const,
  ),
  [
    join(publicRoot, "templates/restricted-profile.json"),
    json(restrictedAgentProfileTemplate),
  ],
]);

async function verifyWorkBuddyBundle(): Promise<string[]> {
  const bundlePath = join(
    repositoryRoot,
    "apps/web/public",
    ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
  );
  const problems: string[] = [];
  try {
    const [bundle, skill, entriesResult, bundledSkillResult] = await Promise.all([
      readFile(bundlePath),
      readFile(publicSkillPath),
      execFileAsync("unzip", ["-Z1", bundlePath], {
        encoding: "utf8",
        maxBuffer: 1_048_576,
      }),
      execFileAsync("unzip", ["-p", bundlePath, "SKILL.md"], {
        encoding: "buffer",
        maxBuffer: 10_485_760,
      }),
    ]);
    const digest = createHash("sha256").update(bundle).digest("hex");
    if (digest !== ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256) {
      problems.push(`${bundlePath} (SHA-256 mismatch)`);
    }
    if (entriesResult.stdout.trim() !== "SKILL.md") {
      problems.push(`${bundlePath} (archive must contain only root SKILL.md)`);
    }
    if (!Buffer.from(bundledSkillResult.stdout).equals(skill)) {
      problems.push(`${bundlePath} (bundled SKILL.md is stale)`);
    }
  } catch (error) {
    problems.push(
      `${bundlePath} (${error instanceof Error ? error.message : "verification failed"})`,
    );
  }
  return problems;
}

async function verifySkillDocument(): Promise<string[]> {
  try {
    const skill = await readFile(publicSkillPath);
    const digest = createHash("sha256").update(skill).digest("hex");
    return digest === ATTENTION_SKILL_DOCUMENT_SHA256
      ? []
      : [`${publicSkillPath} (SHA-256 mismatch)`];
  } catch (error) {
    return [
      `${publicSkillPath} (${error instanceof Error ? error.message : "verification failed"})`,
    ];
  }
}

async function compareArtifacts(): Promise<void> {
  const drift: string[] = [];
  for (const [path, expected] of artifacts) {
    try {
      if ((await readFile(path, "utf8")) !== expected) drift.push(path);
    } catch {
      drift.push(path);
    }
  }

  const expectedAgents = new Set(
    agentInstallationProfiles.map((profile) => `${profile.id}.json`),
  );
  const actualAgents = await readdir(join(publicRoot, "agents"));
  for (const filename of actualAgents) {
    if (filename.endsWith(".json") && !expectedAgents.has(filename)) {
      drift.push(join(publicRoot, "agents", filename));
    }
  }

  drift.push(...(await verifySkillDocument()));
  drift.push(...(await verifyWorkBuddyBundle()));

  if (drift.length) {
    const relative = drift.map((path) => path.replace(`${repositoryRoot}/`, ""));
    throw new Error(
      `Agent installation artifacts are out of sync:\n${relative
        .map((path) => `- ${path}`)
        .join("\n")}\nRun pnpm agent-installations:sync.`,
    );
  }
}

async function writeArtifacts(): Promise<void> {
  for (const [path, contents] of artifacts) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

if (checkOnly) {
  await compareArtifacts();
  console.log("Agent installation artifacts are synchronized.");
} else {
  await writeArtifacts();
  await compareArtifacts();
  console.log(`Wrote ${artifacts.size} Agent installation artifacts.`);
}
