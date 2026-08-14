import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTENTION_BRIDGE_MINIMUM_SUPPORTED_VERSION,
  ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
} from "../apps/cli/src/bridge-update-contract.ts";

interface CliPackage {
  engines?: { node?: string };
  version?: string;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = join(repositoryRoot, "apps/web/public/cli");
const packagePath = join(repositoryRoot, "apps/cli/package.json");
const bundlePath = join(repositoryRoot, "apps/cli/dist/index.js");
const checkOnly = process.argv.includes("--check");

const cliPackage = JSON.parse(await readFile(packagePath, "utf8")) as CliPackage;
const version = cliPackage.version;
const node = cliPackage.engines?.node;

if (!version || !node) {
  throw new Error("Attention CLI package must declare version and Node engine.");
}

const rawBundle = await readFile(bundlePath, "utf8");
// esbuild can preserve insignificant trailing spaces embedded in dependency
// template literals. Normalize them so the published artifact is stable and
// passes the repository's whitespace gate without hand-editing generated code.
const bundle = Buffer.from(rawBundle.replace(/[ \t]+$/gmu, ""));
if (!bundle.subarray(0, 20).toString("utf8").includes("#!/usr/bin/env node")) {
  throw new Error("Attention CLI bundle must start with a Node shebang.");
}

const artifactName = `attention-${version}.mjs`;
const artifactPath = join(publicRoot, artifactName);
const manifestPath = join(publicRoot, "manifest.json");
const sha256 = createHash("sha256").update(bundle).digest("hex");
const manifest = Buffer.from(
  `${JSON.stringify(
    {
      artifact_path: `/cli/${artifactName}`,
      minimum_supported_version: ATTENTION_BRIDGE_MINIMUM_SUPPORTED_VERSION,
      node,
      permission_profile_sha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      schema_version: 2,
      sha256,
      version,
    },
    null,
    2,
  )}\n`,
);

const artifacts = new Map<string, Buffer>([
  [artifactPath, bundle],
  [manifestPath, manifest],
]);

async function compareArtifacts(): Promise<void> {
  const drift: string[] = [];
  for (const [path, expected] of artifacts) {
    try {
      if (!(await readFile(path)).equals(expected)) drift.push(path);
    } catch {
      drift.push(path);
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `Attention CLI artifacts are out of sync:\n${drift
        .map((path) => `- ${path.replace(`${repositoryRoot}/`, "")}`)
        .join("\n")}\nRun pnpm cli-artifact:sync.`,
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
  console.log("Attention CLI artifacts are synchronized.");
} else {
  await writeArtifacts();
  await compareArtifacts();
  console.log(`Wrote ${artifacts.size} Attention CLI artifacts.`);
}
