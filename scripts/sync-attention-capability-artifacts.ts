import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attentionCapabilityManifest,
  createAttentionCapabilityManifestJsonSchema,
} from "../packages/contracts/src/attention-capability-manifest.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = join(
  repositoryRoot,
  "apps/web/public/skills/attention/capabilities/v1",
);
const checkOnly = process.argv.includes("--check");

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const artifacts = new Map<string, string>([
  [join(publicRoot, "index.json"), json(attentionCapabilityManifest)],
  [
    join(publicRoot, "schema.json"),
    json(createAttentionCapabilityManifestJsonSchema()),
  ],
]);

async function compareArtifacts(): Promise<void> {
  const drift: string[] = [];
  for (const [path, expected] of artifacts) {
    try {
      if ((await readFile(path, "utf8")) !== expected) drift.push(path);
    } catch {
      drift.push(path);
    }
  }

  if (drift.length > 0) {
    const relative = drift.map((path) => path.replace(`${repositoryRoot}/`, ""));
    throw new Error(
      `Attention capability artifacts are out of sync:\n${relative
        .map((path) => `- ${path}`)
        .join("\n")}\nRun pnpm capabilities:sync.`,
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
  console.log("Attention capability artifacts are synchronized.");
} else {
  await writeArtifacts();
  await compareArtifacts();
  console.log(`Wrote ${artifacts.size} Attention capability artifacts.`);
}
