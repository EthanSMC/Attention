import { createHash } from "node:crypto";

export const ATTENTION_BRIDGE_PERMISSION_PROFILE = {
  cloud: {
    mcp_server: "attention_only",
    tools: [
      "attention_get_my_account",
      "attention_list_collections",
      "attention_collect_content",
      "attention_submit_content_enrichment",
      "attention_select_collection_candidate",
      "attention_get_collection_status",
      "attention_update_collection",
    ],
  },
  local: {
    deny: [
      "browser_automation",
      "code_execution",
      "filesystem_outside_attention",
      "other_mcp",
      "shell",
    ],
    write: [
      "attention_state",
      "managed_bridge_artifacts",
      "user_service_config",
    ],
  },
  native_network: ["public_web_reader"],
  schema_version: 1,
} as const;

export const ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256 = createHash("sha256")
  .update(JSON.stringify(ATTENTION_BRIDGE_PERMISSION_PROFILE))
  .digest("hex");

export const ATTENTION_BRIDGE_MINIMUM_SUPPORTED_VERSION = "0.3.5";

export interface BridgeUpdateManifest {
  readonly artifact_path: string;
  readonly minimum_supported_version: string;
  readonly node: string;
  readonly permission_profile_sha256: string;
  readonly schema_version: 2;
  readonly sha256: string;
  readonly version: string;
}

export type BridgeUpdateDecision =
  | "consent_required"
  | "current"
  | "update_available"
  | "update_required";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NODE_RANGE_PATTERN = /^>=\d+\.\d+\.\d+$/u;

function semanticVersion(value: unknown): readonly [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.length === 3 && parts.every(Number.isSafeInteger)
    ? (parts as unknown as readonly [number, number, number])
    : null;
}

function compareSemanticVersions(left: string, right: string): number {
  const leftParts = semanticVersion(left);
  const rightParts = semanticVersion(right);
  if (!leftParts || !rightParts) throw new Error("Invalid semantic version.");
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function parseBridgeUpdateManifest(
  value: unknown,
): BridgeUpdateManifest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "artifact_path",
    "minimum_supported_version",
    "node",
    "permission_profile_sha256",
    "schema_version",
    "sha256",
    "version",
  ];
  if (
    Object.keys(record).sort().join("\n") !== expectedKeys.join("\n") ||
    record.schema_version !== 2 ||
    !semanticVersion(record.version) ||
    !semanticVersion(record.minimum_supported_version) ||
    typeof record.node !== "string" ||
    !NODE_RANGE_PATTERN.test(record.node) ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256) ||
    typeof record.permission_profile_sha256 !== "string" ||
    !SHA256_PATTERN.test(record.permission_profile_sha256) ||
    typeof record.artifact_path !== "string" ||
    !/^\/cli\/attention-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.mjs$/u.test(
      record.artifact_path,
    )
  ) {
    return null;
  }
  return record as unknown as BridgeUpdateManifest;
}

export function resolveBridgeUpdateArtifactUrl(
  originValue: string,
  artifactPath: string,
): string {
  const origin = new URL(originValue);
  const artifact = new URL(artifactPath, origin);
  if (artifact.origin !== origin.origin) {
    throw new Error("Bridge update artifact must use the exact same origin.");
  }
  if (
    artifact.username ||
    artifact.password ||
    artifact.search ||
    artifact.hash
  ) {
    throw new Error("Bridge update artifact cannot contain URL metadata.");
  }
  if (!artifactPath.startsWith("/")) {
    throw new Error("Bridge update artifact must use an absolute path.");
  }
  return artifact.toString();
}

export function bridgeUpdateDecision(input: {
  readonly currentPermissionProfileSha256: string;
  readonly currentVersion: string;
  readonly manifest: BridgeUpdateManifest;
}): BridgeUpdateDecision {
  const current = semanticVersion(input.currentVersion);
  const latest = semanticVersion(input.manifest.version);
  if (!current || !latest) throw new Error("Invalid Bridge version.");
  if (
    input.currentPermissionProfileSha256 !==
      input.manifest.permission_profile_sha256 ||
    current[0] !== latest[0]
  ) {
    return "consent_required";
  }
  if (
    compareSemanticVersions(
      input.currentVersion,
      input.manifest.minimum_supported_version,
    ) < 0 &&
    compareSemanticVersions(input.manifest.version, input.currentVersion) <= 0
  ) {
    return "update_required";
  }
  return compareSemanticVersions(input.manifest.version, input.currentVersion) >
    0
    ? "update_available"
    : "current";
}
