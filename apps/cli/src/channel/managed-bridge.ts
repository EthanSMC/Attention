import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const BRIDGE_UPDATE_RESTART_EXIT_CODE = 75;

export type ManagedBridgeUpdateStatus =
  | "checking"
  | "consent_required"
  | "current"
  | "error"
  | "restarting"
  | "rolled_back"
  | "staging"
  | "update_available"
  | "update_required";

export interface ManagedBridgeArtifact {
  readonly artifactPath: string;
  readonly permissionProfileSha256: string;
  readonly version: string;
}

export interface ManagedBridgeUpdateState {
  current: ManagedBridgeArtifact;
  lastCheckAt: string | null;
  lastErrorCode: string | null;
  latestVersion: string | null;
  pending: { readonly startedAt: string; readonly version: string } | null;
  previous: ManagedBridgeArtifact | null;
  readonly schemaVersion: 1;
  status: ManagedBridgeUpdateStatus;
}

export interface ManagedBridgePaths {
  readonly launcherPath: string;
  readonly rootDirectory: string;
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly versionsDirectory: string;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function managedBridgePaths(homeDirectory = homedir()): ManagedBridgePaths {
  const rootDirectory = join(homeDirectory, ".local", "share", "attention");
  const stateDirectory = join(homeDirectory, ".attention", "update");
  return {
    launcherPath: join(rootDirectory, "launcher.mjs"),
    rootDirectory,
    stateDirectory,
    statePath: join(stateDirectory, "state.json"),
    versionsDirectory: join(rootDirectory, "versions"),
  };
}

function validArtifact(value: unknown): value is ManagedBridgeArtifact {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.artifactPath === "string" &&
    isAbsolute(record.artifactPath) &&
    typeof record.permissionProfileSha256 === "string" &&
    SHA256_PATTERN.test(record.permissionProfileSha256) &&
    typeof record.version === "string" &&
    VERSION_PATTERN.test(record.version)
  );
}

function parseManagedBridgeUpdateState(
  value: unknown,
): ManagedBridgeUpdateState {
  if (value === null || typeof value !== "object") {
    throw new Error("Managed Bridge update state is invalid.");
  }
  const record = value as Record<string, unknown>;
  const pending = record.pending;
  if (
    record.schemaVersion !== 1 ||
    !validArtifact(record.current) ||
    !(record.previous === null || validArtifact(record.previous)) ||
    !(
      pending === null ||
      (typeof pending === "object" &&
        typeof (pending as Record<string, unknown>).startedAt === "string" &&
        typeof (pending as Record<string, unknown>).version === "string" &&
        VERSION_PATTERN.test(
          (pending as Record<string, unknown>).version as string,
        ))
    ) ||
    typeof record.status !== "string"
  ) {
    throw new Error("Managed Bridge update state is invalid.");
  }
  return record as unknown as ManagedBridgeUpdateState;
}

async function atomicWrite(
  path: string,
  contents: string | Buffer,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadManagedBridgeUpdateState(
  homeDirectory = homedir(),
): Promise<ManagedBridgeUpdateState> {
  const raw = await readFile(managedBridgePaths(homeDirectory).statePath, "utf8");
  return parseManagedBridgeUpdateState(JSON.parse(raw));
}

export async function saveManagedBridgeUpdateState(
  state: ManagedBridgeUpdateState,
  homeDirectory = homedir(),
): Promise<void> {
  const normalized = parseManagedBridgeUpdateState(state);
  const { stateDirectory, statePath } = managedBridgePaths(homeDirectory);
  await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  await chmod(stateDirectory, 0o700);
  await atomicWrite(statePath, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
}

export async function bootstrapManagedBridge(input: {
  readonly currentArtifactPath: string;
  readonly homeDirectory?: string;
  readonly permissionProfileSha256: string;
  readonly version: string;
}): Promise<{ readonly artifactPath: string; readonly launcherPath: string }> {
  if (
    !VERSION_PATTERN.test(input.version) ||
    !SHA256_PATTERN.test(input.permissionProfileSha256)
  ) {
    throw new Error("Managed Bridge release identity is invalid.");
  }
  const home = input.homeDirectory ?? homedir();
  const paths = managedBridgePaths(home);
  await mkdir(paths.rootDirectory, { mode: 0o700, recursive: true });
  await mkdir(paths.versionsDirectory, { mode: 0o700, recursive: true });
  await chmod(paths.rootDirectory, 0o700);
  await chmod(paths.versionsDirectory, 0o700);
  const artifactPath = join(
    paths.versionsDirectory,
    `attention-${input.version}.mjs`,
  );
  const currentContents = await readFile(input.currentArtifactPath);
  try {
    const existing = await readFile(artifactPath);
    if (!existing.equals(currentContents)) {
      throw new Error("Managed Bridge version already exists with different bytes.");
    }
    await chmod(artifactPath, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(artifactPath, currentContents, 0o700);
  }
  await atomicWrite(paths.launcherPath, buildManagedBridgeLauncher(), 0o700);
  await saveManagedBridgeUpdateState(
    {
      current: {
        artifactPath,
        permissionProfileSha256: input.permissionProfileSha256,
        version: input.version,
      },
      lastCheckAt: null,
      lastErrorCode: null,
      latestVersion: input.version,
      pending: null,
      previous: null,
      schemaVersion: 1,
      status: "current",
    },
    home,
  );
  return { artifactPath, launcherPath: paths.launcherPath };
}

export async function markManagedBridgeHealthy(
  version: string,
  homeDirectory = homedir(),
): Promise<void> {
  let state: ManagedBridgeUpdateState;
  try {
    state = await loadManagedBridgeUpdateState(homeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (state.pending?.version !== version || state.current.version !== version) {
    return;
  }
  state.pending = null;
  state.previous = null;
  state.status = "current";
  state.lastErrorCode = null;
  await saveManagedBridgeUpdateState(state, homeDirectory);
}

export function buildManagedBridgeLauncher(): string {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const restartExitCode = ${BRIDGE_UPDATE_RESTART_EXIT_CODE};
const statePath = process.env.ATTENTION_BRIDGE_UPDATE_STATE_PATH || join(homedir(), ".attention", "update", "state.json");
const requestedTimeout = Number(process.env.ATTENTION_BRIDGE_STARTUP_TIMEOUT_MS || "120000");
const startupTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout >= 50 ? requestedTimeout : 120000;

function loadState() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(statePath), { mode: 0o700, recursive: true });
  chmodSync(dirname(statePath), 0o700);
  const temporary = statePath + ".launcher-" + process.pid + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, statePath);
    chmodSync(statePath, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function run(artifactPath, pendingVersion) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [artifactPath, ...process.argv.slice(2)], {
      env: { ...process.env, ATTENTION_BRIDGE_UPDATE_STATE_PATH: statePath },
      stdio: "inherit",
    });
    const forward = (signal) => child.kill(signal);
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    let timedOut = false;
    let killTimer;
    const timer = pendingVersion ? setTimeout(() => {
      let stillPending = false;
      try { stillPending = loadState().pending?.version === pendingVersion; } catch {}
      if (stillPending) {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      }
    }, startupTimeoutMs) : undefined;
    timer?.unref?.();
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      resolve({ code: code ?? (signal ? 1 : 0), timedOut });
    });
    child.once("error", () => resolve({ code: 1, timedOut: false }));
  });
}

for (;;) {
  const before = loadState();
  const pendingVersion = before.pending?.version === before.current.version ? before.current.version : null;
  const result = await run(before.current.artifactPath, pendingVersion);
  const after = loadState();
  if (pendingVersion && after.pending?.version === pendingVersion) {
    if (!after.previous) {
      process.exitCode = result.code || 1;
      break;
    }
    after.current = after.previous;
    after.previous = null;
    after.pending = null;
    after.status = "rolled_back";
    after.lastErrorCode = result.timedOut ? "candidate_startup_timeout" : "candidate_startup_failed";
    saveState(after);
    continue;
  }
  if (result.code === restartExitCode) continue;
  process.exitCode = result.code;
  break;
}
`;
}
