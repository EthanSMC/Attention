import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  bridgeUpdateDecision,
} from "../bridge-update-contract";
import { type CommandRunner, runCommand } from "../command-runner";
import { normalizeAttentionOrigin } from "../origin";
import {
  AttentionReleaseError,
  fetchAttentionReleaseArtifact,
  fetchAttentionReleaseManifest,
  nodeRuntimeSatisfies,
} from "../release-client";
import {
  loadManagedBridgeUpdateState,
  managedBridgePaths,
  saveManagedBridgeUpdateState,
} from "./managed-bridge";

const FETCH_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;

export type BridgeUpdateCheckResult =
  | { readonly status: "consent_required"; readonly version: string }
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "error"; readonly errorCode: string }
  | { readonly status: "staged"; readonly version: string };

export interface BridgeUpdaterOptions {
  readonly currentPermissionProfileSha256: string;
  readonly currentVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly homeDirectory: string;
  readonly nodeExecutable?: string;
  readonly nodeVersion?: string;
  readonly now?: () => Date;
  readonly origin: string;
  readonly runner?: CommandRunner;
}

class BridgeUpdateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function parseProbeOutput(
  stdout: string,
): { readonly permissionProfileSha256: string; readonly version: string } | null {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!exactKeys(record, ["permission_profile_sha256", "version"])) return null;
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

async function atomicWrite(path: string, contents: Buffer): Promise<void> {
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

function stableErrorCode(error: unknown): string {
  return error instanceof BridgeUpdateError || error instanceof AttentionReleaseError
    ? error.code
    : "bridge_update_unexpected";
}

export async function checkAndStageBridgeUpdate(
  options: BridgeUpdaterOptions,
): Promise<BridgeUpdateCheckResult> {
  const now = options.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  let state = await loadManagedBridgeUpdateState(options.homeDirectory);
  const originalCurrent = state.current;
  const origin = normalizeAttentionOrigin(options.origin);

  try {
    state.status = "checking";
    state.lastCheckAt = checkedAt;
    state.lastErrorCode = null;
    await saveManagedBridgeUpdateState(state, options.homeDirectory);

    const manifest = await fetchAttentionReleaseManifest({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      origin,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    state.latestVersion = manifest.version;
    if (!nodeRuntimeSatisfies(options.nodeVersion ?? process.versions.node, manifest.node)) {
      throw new BridgeUpdateError("node_version_unsupported");
    }

    const decision = bridgeUpdateDecision({
      currentPermissionProfileSha256: options.currentPermissionProfileSha256,
      currentVersion: options.currentVersion,
      manifest,
    });
    if (decision === "current") {
      state.status = "current";
      await saveManagedBridgeUpdateState(state, options.homeDirectory);
      return { status: "current", version: manifest.version };
    }
    if (decision === "consent_required") {
      state.status = "consent_required";
      state.pending = null;
      await saveManagedBridgeUpdateState(state, options.homeDirectory);
      return { status: "consent_required", version: manifest.version };
    }

    state.status = decision;
    await saveManagedBridgeUpdateState(state, options.homeDirectory);
    const artifact = await fetchAttentionReleaseArtifact({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      manifest,
      origin,
      timeoutMs: FETCH_TIMEOUT_MS,
    });

    const paths = managedBridgePaths(options.homeDirectory);
    const candidatePath = join(paths.versionsDirectory, `attention-${manifest.version}.mjs`);
    try {
      const existing = await readFile(candidatePath);
      if (!existing.equals(artifact)) {
        throw new BridgeUpdateError("artifact_version_collision");
      }
      await chmod(candidatePath, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(candidatePath, artifact);
    }

    const runner = options.runner ?? runCommand;
    const probe = await runner(
      {
        args: [candidatePath, "--bridge-update-probe"],
        executable: options.nodeExecutable ?? process.execPath,
      },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const identity = parseProbeOutput(probe.stdout);
    if (
      probe.exitCode !== 0 ||
      probe.timedOut ||
      !identity ||
      identity.version !== manifest.version ||
      identity.permissionProfileSha256 !== manifest.permission_profile_sha256
    ) {
      await rm(candidatePath, { force: true });
      throw new BridgeUpdateError("candidate_probe_failed");
    }

    state = await loadManagedBridgeUpdateState(options.homeDirectory);
    if (
      state.current.version !== originalCurrent.version ||
      state.current.artifactPath !== originalCurrent.artifactPath
    ) {
      throw new BridgeUpdateError("bridge_update_state_changed");
    }
    state.previous = state.current;
    state.current = {
      artifactPath: candidatePath,
      permissionProfileSha256: manifest.permission_profile_sha256,
      version: manifest.version,
    };
    state.pending = { startedAt: checkedAt, version: manifest.version };
    state.status = "restarting";
    state.lastErrorCode = null;
    state.latestVersion = manifest.version;
    await saveManagedBridgeUpdateState(state, options.homeDirectory);
    return { status: "staged", version: manifest.version };
  } catch (error) {
    state = await loadManagedBridgeUpdateState(options.homeDirectory);
    state.current = originalCurrent;
    state.pending = null;
    state.previous = null;
    state.status = "error";
    state.lastCheckAt = checkedAt;
    state.lastErrorCode = stableErrorCode(error);
    await saveManagedBridgeUpdateState(state, options.homeDirectory);
    return { status: "error", errorCode: state.lastErrorCode };
  }
}
