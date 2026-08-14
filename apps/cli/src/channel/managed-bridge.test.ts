import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapManagedBridge,
  buildManagedBridgeLauncher,
  loadManagedBridgeUpdateState,
  managedBridgePaths,
  saveManagedBridgeUpdateState,
} from "./managed-bridge";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const permissionHash = "2b2bca585577cd6f0d2adc310f798a8e200ac6a274862b3564c9b36408c1606d";

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "attention-managed-bridge-"));
  temporaryDirectories.push(home);
  return home;
}

async function executableScript(path: string, source: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(path, 0o700);
}

describe("managed Bridge launcher", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      temporaryDirectories.splice(0).map(async (path) =>
        await rm(path, { force: true, recursive: true }),
      ),
    );
  });

  it("bootstraps immutable versioned code and a stable user-owned launcher", async () => {
    const home = await temporaryHome();
    const source = join(home, "downloaded-attention.mjs");
    await executableScript(source, 'console.log("0.3.5")');

    const installation = await bootstrapManagedBridge({
      currentArtifactPath: source,
      homeDirectory: home,
      permissionProfileSha256: permissionHash,
      version: "0.3.5",
    });
    const paths = managedBridgePaths(home);
    const state = await loadManagedBridgeUpdateState(home);

    expect(installation.launcherPath).toBe(paths.launcherPath);
    expect(await readFile(installation.artifactPath, "utf8")).toBe(
      await readFile(source, "utf8"),
    );
    expect(state.current).toEqual({
      artifactPath: installation.artifactPath,
      permissionProfileSha256: permissionHash,
      version: "0.3.5",
    });
    expect(state.pending).toBeNull();
    expect((await stat(paths.rootDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.launcherPath)).mode & 0o777).toBe(0o700);
  });

  it("keeps a pending candidate after it reports healthy", async () => {
    const home = await temporaryHome();
    const paths = managedBridgePaths(home);
    const oldArtifact = join(home, "old.mjs");
    const newArtifact = join(home, "new.mjs");
    const logPath = join(home, "runs.log");
    await executableScript(oldArtifact, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(logPath)}, "old\\n")`);
    await executableScript(
      newArtifact,
      `
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(logPath)}, "new\\n");
const path = process.env.ATTENTION_BRIDGE_UPDATE_STATE_PATH;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
state.pending = null;
state.previous = null;
state.status = "current";
fs.writeFileSync(path, JSON.stringify(state));
`,
    );
    await saveManagedBridgeUpdateState(
      {
        current: { artifactPath: newArtifact, permissionProfileSha256: permissionHash, version: "0.3.6" },
        lastCheckAt: "2026-08-14T00:00:00.000Z",
        lastErrorCode: null,
        latestVersion: "0.3.6",
        pending: { startedAt: "2026-08-14T00:00:00.000Z", version: "0.3.6" },
        previous: { artifactPath: oldArtifact, permissionProfileSha256: permissionHash, version: "0.3.5" },
        schemaVersion: 1,
        status: "restarting",
      },
      home,
    );
    await (await import("node:fs/promises")).mkdir(paths.rootDirectory, {
      recursive: true,
    });
    await writeFile(paths.launcherPath, buildManagedBridgeLauncher(), {
      mode: 0o700,
    });

    await execFileAsync(process.execPath, [paths.launcherPath], {
      env: {
        ...process.env,
        ATTENTION_BRIDGE_STARTUP_TIMEOUT_MS: "500",
        ATTENTION_BRIDGE_UPDATE_STATE_PATH: paths.statePath,
      },
    });

    expect(await readFile(logPath, "utf8")).toBe("new\n");
    expect((await loadManagedBridgeUpdateState(home)).current.version).toBe(
      "0.3.6",
    );
  });

  it("rolls back and starts the prior artifact when a candidate exits before healthy", async () => {
    const home = await temporaryHome();
    const paths = managedBridgePaths(home);
    const oldArtifact = join(home, "old.mjs");
    const newArtifact = join(home, "new.mjs");
    const logPath = join(home, "runs.log");
    await executableScript(oldArtifact, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(logPath)}, "old\\n")`);
    await executableScript(
      newArtifact,
      `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(logPath)}, "new\\n"); process.exitCode = 1`,
    );
    await saveManagedBridgeUpdateState(
      {
        current: { artifactPath: newArtifact, permissionProfileSha256: permissionHash, version: "0.3.6" },
        lastCheckAt: "2026-08-14T00:00:00.000Z",
        lastErrorCode: null,
        latestVersion: "0.3.6",
        pending: { startedAt: "2026-08-14T00:00:00.000Z", version: "0.3.6" },
        previous: { artifactPath: oldArtifact, permissionProfileSha256: permissionHash, version: "0.3.5" },
        schemaVersion: 1,
        status: "restarting",
      },
      home,
    );
    await (await import("node:fs/promises")).mkdir(paths.rootDirectory, {
      recursive: true,
    });
    await writeFile(paths.launcherPath, buildManagedBridgeLauncher(), {
      mode: 0o700,
    });

    await execFileAsync(process.execPath, [paths.launcherPath], {
      env: {
        ...process.env,
        ATTENTION_BRIDGE_STARTUP_TIMEOUT_MS: "500",
        ATTENTION_BRIDGE_UPDATE_STATE_PATH: paths.statePath,
      },
    });

    expect(await readFile(logPath, "utf8")).toBe("new\nold\n");
    expect(await loadManagedBridgeUpdateState(home)).toMatchObject({
      current: { version: "0.3.5" },
      lastErrorCode: "candidate_startup_failed",
      pending: null,
      status: "rolled_back",
    });
  });

  it("terminates and rolls back a candidate that never reaches healthy", async () => {
    const home = await temporaryHome();
    const paths = managedBridgePaths(home);
    const oldArtifact = join(home, "old.mjs");
    const newArtifact = join(home, "new.mjs");
    const logPath = join(home, "runs.log");
    await executableScript(
      oldArtifact,
      `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(logPath)}, "old\\n")`,
    );
    await executableScript(
      newArtifact,
      `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(logPath)}, "new\\n"); setInterval(() => {}, 1000)`,
    );
    await saveManagedBridgeUpdateState(
      {
        current: { artifactPath: newArtifact, permissionProfileSha256: permissionHash, version: "0.3.6" },
        lastCheckAt: "2026-08-14T00:00:00.000Z",
        lastErrorCode: null,
        latestVersion: "0.3.6",
        pending: { startedAt: "2026-08-14T00:00:00.000Z", version: "0.3.6" },
        previous: { artifactPath: oldArtifact, permissionProfileSha256: permissionHash, version: "0.3.5" },
        schemaVersion: 1,
        status: "restarting",
      },
      home,
    );
    await (await import("node:fs/promises")).mkdir(paths.rootDirectory, {
      recursive: true,
    });
    await writeFile(paths.launcherPath, buildManagedBridgeLauncher(), {
      mode: 0o700,
    });

    await execFileAsync(process.execPath, [paths.launcherPath], {
      env: {
        ...process.env,
        ATTENTION_BRIDGE_STARTUP_TIMEOUT_MS: "80",
        ATTENTION_BRIDGE_UPDATE_STATE_PATH: paths.statePath,
      },
      timeout: 5_000,
    });

    expect(await readFile(logPath, "utf8")).toBe("new\nold\n");
    expect(await loadManagedBridgeUpdateState(home)).toMatchObject({
      current: { version: "0.3.5" },
      lastErrorCode: "candidate_startup_timeout",
      pending: null,
      status: "rolled_back",
    });
  });
});
