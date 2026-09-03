import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { compareSemanticVersions } from "./bridge-update-contract";
import { type CommandRunner, runCommand } from "./command-runner";
import { ATTENTION_ORIGIN_ENV, normalizeAttentionOrigin } from "./origin";
import {
  AttentionReleaseError,
  fetchAttentionReleaseArtifact,
  fetchAttentionReleaseManifest,
  nodeRuntimeSatisfies,
} from "./release-client";

const CLI_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const STARTUP_FETCH_TIMEOUT_MS = 1_500;
const UPDATE_FETCH_TIMEOUT_MS = 15_000;
const CANDIDATE_PROBE_TIMEOUT_MS = 10_000;
const MAXIMUM_ORIGIN_RECORDS = 4;

interface CliUpdateOriginRecord {
  readonly lastAttemptAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly latestVersion: string | null;
  readonly origin: string;
}

interface CliUpdateState {
  readonly origins: readonly CliUpdateOriginRecord[];
  readonly schemaVersion: 1;
  readonly trustedOrigin: string | null;
}

export interface CliUpdateNotice {
  readonly currentVersion: string;
  readonly latestVersion: string;
}

export interface CliUpdateStartupOptions {
  readonly currentVersion: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly explicitOrigin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly homeDirectory?: string;
  readonly nodeVersion?: string;
  readonly now?: () => Date;
}

export type CliUpdateResult =
  | { readonly status: "current"; readonly version: string }
  | {
      readonly fromVersion: string;
      readonly installationKind: "managed_symlink";
      readonly status: "updated";
      readonly toVersion: string;
    }
  | {
      readonly errorCode: string;
      readonly installationKind: "managed_symlink" | "unsupported";
      readonly status: "error";
    };

export interface CliUpdateOptions extends CliUpdateStartupOptions {
  readonly commandPath?: string;
  readonly nodeExecutable?: string;
  readonly runner?: CommandRunner;
}

function defaultState(): CliUpdateState {
  return { origins: [], schemaVersion: 1, trustedOrigin: null };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseOriginRecord(value: unknown): CliUpdateOriginRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "lastAttemptAt",
      "lastErrorCode",
      "lastValidatedAt",
      "latestVersion",
      "origin",
    ]) ||
    typeof record.origin !== "string" ||
    !nullableString(record.lastAttemptAt) ||
    !nullableString(record.lastErrorCode) ||
    !nullableString(record.lastValidatedAt) ||
    !nullableString(record.latestVersion)
  ) {
    return null;
  }
  try {
    if (normalizeAttentionOrigin(record.origin) !== record.origin) return null;
  } catch {
    return null;
  }
  return record as unknown as CliUpdateOriginRecord;
}

function parseState(value: unknown): CliUpdateState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["origins", "schemaVersion", "trustedOrigin"]) ||
    record.schemaVersion !== 1 ||
    !nullableString(record.trustedOrigin) ||
    !Array.isArray(record.origins) ||
    record.origins.length > MAXIMUM_ORIGIN_RECORDS
  ) {
    return null;
  }
  const origins = record.origins.map(parseOriginRecord);
  if (origins.some((origin) => origin === null)) return null;
  if (
    record.trustedOrigin !== null &&
    !origins.some((origin) => origin?.origin === record.trustedOrigin)
  ) {
    return null;
  }
  return {
    origins: origins as CliUpdateOriginRecord[],
    schemaVersion: 1,
    trustedOrigin: record.trustedOrigin,
  };
}

function statePath(homeDirectory: string): string {
  return join(homeDirectory, ".attention", "cli-update", "state.json");
}

async function loadState(homeDirectory: string): Promise<CliUpdateState> {
  try {
    const value = JSON.parse(await readFile(statePath(homeDirectory), "utf8"));
    return parseState(value) ?? defaultState();
  } catch {
    return defaultState();
  }
}

async function saveState(
  state: CliUpdateState,
  homeDirectory: string,
): Promise<void> {
  const path = statePath(homeDirectory);
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function selectedOrigin(
  options: CliUpdateStartupOptions,
  state: CliUpdateState,
): string | null {
  const raw =
    options.explicitOrigin ??
    (options.environment ?? process.env)[ATTENTION_ORIGIN_ENV] ??
    state.trustedOrigin;
  return raw ? normalizeAttentionOrigin(raw) : null;
}

function errorCode(error: unknown): string {
  return error instanceof AttentionReleaseError
    ? error.code
    : error instanceof Error && error.message === "node_version_unsupported"
      ? error.message
      : "cli_update_unexpected";
}

class CliUpdateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function explicitErrorCode(error: unknown): string {
  if (error instanceof AttentionReleaseError || error instanceof CliUpdateError) {
    return error.code;
  }
  return "cli_update_unexpected";
}

function noticeFor(
  record: CliUpdateOriginRecord | undefined,
  currentVersion: string,
): CliUpdateNotice | null {
  if (
    !record?.latestVersion ||
    compareSemanticVersions(record.latestVersion, currentVersion) <= 0
  ) {
    return null;
  }
  return { currentVersion, latestVersion: record.latestVersion };
}

function replaceOriginRecord(
  state: CliUpdateState,
  updated: CliUpdateOriginRecord,
  trustedOrigin = state.trustedOrigin,
): CliUpdateState {
  return {
    origins: [
      updated,
      ...state.origins.filter((record) => record.origin !== updated.origin),
    ].slice(0, MAXIMUM_ORIGIN_RECORDS),
    schemaVersion: 1,
    trustedOrigin,
  };
}

export async function checkCliUpdateAtStartup(
  options: CliUpdateStartupOptions,
): Promise<CliUpdateNotice | null> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const now = options.now?.() ?? new Date();
  let state = await loadState(homeDirectory);
  let origin: string | null;
  try {
    origin = selectedOrigin(options, state);
  } catch {
    return null;
  }
  if (!origin) return null;

  const existing = state.origins.find((record) => record.origin === origin);
  const lastAttemptAt = existing?.lastAttemptAt
    ? Date.parse(existing.lastAttemptAt)
    : Number.NaN;
  if (
    Number.isFinite(lastAttemptAt) &&
    now.getTime() - lastAttemptAt < CLI_UPDATE_INTERVAL_MS
  ) {
    return noticeFor(existing, options.currentVersion);
  }

  try {
    const manifest = await fetchAttentionReleaseManifest({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      origin,
      timeoutMs: STARTUP_FETCH_TIMEOUT_MS,
    });
    if (!nodeRuntimeSatisfies(options.nodeVersion ?? process.versions.node, manifest.node)) {
      throw new Error("node_version_unsupported");
    }
    const checkedAt = now.toISOString();
    const updated: CliUpdateOriginRecord = {
      lastAttemptAt: checkedAt,
      lastErrorCode: null,
      lastValidatedAt: checkedAt,
      latestVersion: manifest.version,
      origin,
    };
    state = replaceOriginRecord(state, updated, origin);
    await saveState(state, homeDirectory);
    return noticeFor(updated, options.currentVersion);
  } catch (error) {
    const updated: CliUpdateOriginRecord = {
      lastAttemptAt: now.toISOString(),
      lastErrorCode: errorCode(error),
      lastValidatedAt: existing?.lastValidatedAt ?? null,
      latestVersion: existing?.latestVersion ?? null,
      origin,
    };
    try {
      await saveState(replaceOriginRecord(state, updated), homeDirectory);
    } catch {
      // Startup update checks never affect the primary CLI command.
    }
    return noticeFor(updated, options.currentVersion);
  }
}

interface ManagedInstallation {
  readonly commandPath: string;
  readonly currentArtifactPath: string;
  readonly originalTarget: string;
  readonly releasesDirectory: string;
}

async function managedInstallation(
  commandPathValue: string | undefined,
  homeDirectory: string,
): Promise<ManagedInstallation> {
  const commandPath = commandPathValue
    ? resolve(commandPathValue)
    : join(homeDirectory, ".local", "bin", "attention");
  if (commandPath !== join(homeDirectory, ".local", "bin", "attention")) {
    throw new CliUpdateError("unsupported_installation");
  }
  const commandStat = await lstat(commandPath);
  if (!commandStat.isSymbolicLink()) {
    throw new CliUpdateError("unsupported_installation");
  }
  const originalTarget = await readlink(commandPath);
  const currentArtifactPath = resolve(dirname(commandPath), originalTarget);
  const releasesDirectory = join(homeDirectory, ".local", "share", "attention");
  if (
    dirname(currentArtifactPath) !== releasesDirectory ||
    !/^attention-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.mjs$/u.test(
      basename(currentArtifactPath),
    ) ||
    !(await lstat(currentArtifactPath)).isFile()
  ) {
    throw new CliUpdateError("unsupported_installation");
  }
  return {
    commandPath,
    currentArtifactPath,
    originalTarget,
    releasesDirectory,
  };
}

async function atomicWriteArtifact(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o700 });
    await rename(temporary, path);
    await chmod(path, 0o700);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseProbeOutput(
  stdout: string,
): { readonly permissionProfileSha256: string; readonly version: string } | null {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (!exactKeys(record, ["permission_profile_sha256", "version"])) {
      return null;
    }
    return typeof record.permission_profile_sha256 === "string" &&
      typeof record.version === "string"
      ? {
          permissionProfileSha256: record.permission_profile_sha256,
          version: record.version,
        }
      : null;
  } catch {
    return null;
  }
}

async function saveValidatedManifest(
  state: CliUpdateState,
  origin: string,
  version: string,
  checkedAt: string,
  homeDirectory: string,
): Promise<CliUpdateState> {
  const updated = replaceOriginRecord(
    state,
    {
      lastAttemptAt: checkedAt,
      lastErrorCode: null,
      lastValidatedAt: checkedAt,
      latestVersion: version,
      origin,
    },
    origin,
  );
  try {
    await saveState(updated, homeDirectory);
  } catch {
    // A cache failure must not make an otherwise safe explicit update fail.
  }
  return updated;
}

export async function updateAttentionCli(
  options: CliUpdateOptions,
): Promise<CliUpdateResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const currentVersion = options.currentVersion;
  let installationKind: "managed_symlink" | "unsupported" = "unsupported";
  let createdCandidatePath: string | null = null;
  try {
    let state = await loadState(homeDirectory);
    const origin = selectedOrigin(options, state);
    if (!origin) throw new CliUpdateError("missing_origin");
    const manifest = await fetchAttentionReleaseManifest({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      origin,
      timeoutMs: UPDATE_FETCH_TIMEOUT_MS,
    });
    if (!nodeRuntimeSatisfies(options.nodeVersion ?? process.versions.node, manifest.node)) {
      throw new CliUpdateError("node_version_unsupported");
    }
    const checkedAt = (options.now?.() ?? new Date()).toISOString();
    state = await saveValidatedManifest(
      state,
      origin,
      manifest.version,
      checkedAt,
      homeDirectory,
    );
    if (compareSemanticVersions(manifest.version, currentVersion) <= 0) {
      return { status: "current", version: currentVersion };
    }

    const installation = await managedInstallation(
      options.commandPath ?? process.argv[1],
      homeDirectory,
    );
    installationKind = "managed_symlink";
    const artifact = await fetchAttentionReleaseArtifact({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      manifest,
      origin,
      timeoutMs: UPDATE_FETCH_TIMEOUT_MS,
    });
    const candidatePath = join(
      installation.releasesDirectory,
      basename(manifest.artifact_path),
    );
    try {
      const existing = await readFile(candidatePath);
      if (!existing.equals(artifact)) {
        throw new CliUpdateError("artifact_version_collision");
      }
      await chmod(candidatePath, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWriteArtifact(candidatePath, artifact);
      createdCandidatePath = candidatePath;
    }

    const runner = options.runner ?? runCommand;
    const probe = await runner(
      {
        args: [candidatePath, "--bridge-update-probe"],
        executable: options.nodeExecutable ?? process.execPath,
      },
      { timeoutMs: CANDIDATE_PROBE_TIMEOUT_MS },
    );
    const identity = parseProbeOutput(probe.stdout);
    if (
      probe.exitCode !== 0 ||
      probe.timedOut ||
      !identity ||
      identity.version !== manifest.version ||
      identity.permissionProfileSha256 !== manifest.permission_profile_sha256
    ) {
      throw new CliUpdateError("candidate_probe_failed");
    }

    if (
      !(await lstat(installation.commandPath)).isSymbolicLink() ||
      (await readlink(installation.commandPath)) !== installation.originalTarget
    ) {
      throw new CliUpdateError("cli_installation_changed");
    }
    const nextTarget = relative(dirname(installation.commandPath), candidatePath);
    const temporaryLink = `${installation.commandPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await symlink(nextTarget, temporaryLink);
      await rename(temporaryLink, installation.commandPath);
    } finally {
      await rm(temporaryLink, { force: true });
    }
    createdCandidatePath = null;
    return {
      fromVersion: currentVersion,
      installationKind: "managed_symlink",
      status: "updated",
      toVersion: manifest.version,
    };
  } catch (error) {
    if (createdCandidatePath) {
      await rm(createdCandidatePath, { force: true });
    }
    return {
      errorCode: explicitErrorCode(error),
      installationKind,
      status: "error",
    };
  }
}
