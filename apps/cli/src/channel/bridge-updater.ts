import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  bridgeUpdateDecision,
  type BridgeUpdateManifest,
  ATTENTION_BRIDGE_UPDATE_PROTOCOL,
  compareSemanticVersions,
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
import { releaseIdentity, updateDigest } from "./bridge-update-offer";
import type { ManagedBridgeArtifact } from "./managed-bridge";

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
  readonly signal?: AbortSignal;
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

export interface PreparedBridgeUpdate {
  readonly manifest: BridgeUpdateManifest;
  readonly candidatePath: string;
  readonly originalCurrent: ManagedBridgeArtifact;
  readonly identity: string;
}

/** Preparation never selects an artifact. Only an exact approval permits a changed profile. */
export async function prepareBridgeUpdate(
  options: BridgeUpdaterOptions,
  manifest: BridgeUpdateManifest,
  approvedIdentity?: string,
): Promise<PreparedBridgeUpdate> {
  options.signal?.throwIfAborted();
  if (compareSemanticVersions(manifest.version,options.currentVersion)<=0) throw new BridgeUpdateError("candidate_not_newer");
  const identity = releaseIdentity(options.origin, manifest, options.currentVersion, options.currentPermissionProfileSha256);
  const latest = await fetchAttentionReleaseManifest({...options, timeoutMs: FETCH_TIMEOUT_MS});
  if (releaseIdentity(options.origin, latest, options.currentVersion, options.currentPermissionProfileSha256) !== identity) {
    throw new BridgeUpdateError("release_identity_changed");
  }
  if (!nodeRuntimeSatisfies(options.nodeVersion ?? process.versions.node, manifest.node)) throw new BridgeUpdateError("node_version_unsupported");
  if (bridgeUpdateDecision({...options, manifest}) === "consent_required" && approvedIdentity !== identity) {
    throw new BridgeUpdateError("approval_required");
  }
  const state = await loadManagedBridgeUpdateState(options.homeDirectory);
  if (state.pending || state.current.version !== options.currentVersion || state.current.permissionProfileSha256 !== options.currentPermissionProfileSha256) {
    throw new BridgeUpdateError("bridge_update_state_changed");
  }
  const artifact = await fetchAttentionReleaseArtifact({...options, manifest, timeoutMs: FETCH_TIMEOUT_MS});
  options.signal?.throwIfAborted();
  const candidatePath = join(managedBridgePaths(options.homeDirectory).versionsDirectory, `attention-${manifest.version}.mjs`);
  let created = false;
  try {
    const existing = await readFile(candidatePath);
    if (!existing.equals(artifact)) throw new BridgeUpdateError("artifact_version_collision");
    await chmod(candidatePath, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(candidatePath, artifact);
    created = true;
  }
  options.signal?.throwIfAborted();
  const probe = await (options.runner ?? runCommand)({args:[candidatePath,"--bridge-update-probe"],executable:options.nodeExecutable ?? process.execPath},{timeoutMs:PROBE_TIMEOUT_MS,...(options.signal?{signal:options.signal}:{})});
  options.signal?.throwIfAborted();
  const probeIdentity = parseProbeOutput(probe.stdout);
  if (probe.exitCode !== 0 || probe.timedOut || probeIdentity?.version !== manifest.version || probeIdentity.permissionProfileSha256 !== manifest.permission_profile_sha256) {
    if (created) await rm(candidatePath, {force:true});
    throw new BridgeUpdateError("candidate_probe_failed");
  }
  const protocol = await (options.runner ?? runCommand)({args:[candidatePath,"--bridge-update-protocol"],executable:options.nodeExecutable ?? process.execPath},{timeoutMs:PROBE_TIMEOUT_MS,...(options.signal?{signal:options.signal}:{})});
  options.signal?.throwIfAborted();
  let compatible = false;
  try {
    const value = JSON.parse(protocol.stdout.trim()) as Record<string,unknown>;
    compatible = protocol.exitCode === 0 && !protocol.timedOut && !!value &&
      exactKeys(value,Object.keys(ATTENTION_BRIDGE_UPDATE_PROTOCOL)) &&
      Object.entries(ATTENTION_BRIDGE_UPDATE_PROTOCOL).every(([key,version])=>value[key]===version);
  } catch { /* Older candidates without the protocol are not safe for this lifecycle. */ }
  if (!compatible) {
    if (created) await rm(candidatePath,{force:true});
    throw new BridgeUpdateError("candidate_update_protocol_unsupported");
  }
  return {manifest,candidatePath,originalCurrent:state.current,identity};
}

/** Caller holds the channel service lock and has drained/acknowledged its outbox. */
export async function activateBridgeUpdate(
  options: BridgeUpdaterOptions,
  prepared: PreparedBridgeUpdate,
  mayActivate: () => boolean = () => true,
): Promise<void> {
  const manifest = await fetchAttentionReleaseManifest({...options,timeoutMs:FETCH_TIMEOUT_MS});
  if (releaseIdentity(options.origin,manifest,options.currentVersion,options.currentPermissionProfileSha256) !== prepared.identity) throw new BridgeUpdateError("release_identity_changed");
  const bytes = await readFile(prepared.candidatePath);
  const { createHash } = await import("node:crypto");
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new BridgeUpdateError("artifact_digest_mismatch");
  const state = await loadManagedBridgeUpdateState(options.homeDirectory);
  if (state.pending || updateDigest(state.current) !== updateDigest(prepared.originalCurrent)) throw new BridgeUpdateError("bridge_update_state_changed");
  if (!mayActivate()) throw new BridgeUpdateError("approval_expired_or_cancelled");
  state.previous = state.current;
  state.current = {artifactPath:prepared.candidatePath,permissionProfileSha256:manifest.permission_profile_sha256,version:manifest.version};
  state.pending = {startedAt:(options.now?.() ?? new Date()).toISOString(),version:manifest.version};
  state.status = "restarting";
  state.lastErrorCode = null;
  state.latestVersion = manifest.version;
  await saveManagedBridgeUpdateState(state,options.homeDirectory);
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
    const prepared = await prepareBridgeUpdate(options,manifest);
    await activateBridgeUpdate(options,prepared);
    return { status: "staged", version: manifest.version };
  } catch (error) {
    state = await loadManagedBridgeUpdateState(options.homeDirectory);
    const errorCode = stableErrorCode(error);
    if (updateDigest(state.current) === updateDigest(originalCurrent) && !state.pending) {
      state.status = "error";
      state.lastCheckAt = checkedAt;
      state.lastErrorCode = errorCode;
      await saveManagedBridgeUpdateState(state, options.homeDirectory);
    }
    return { status: "error", errorCode };
  }
}
