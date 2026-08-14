import bridgeUpdateManifest from "../../public/cli/manifest.json";

export type BridgeDeviceVersionStatus =
  | "current"
  | "manual"
  | "recommended"
  | "required"
  | "unknown";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function bridgeDeviceVersionView(input: {
  readonly installedVersion: string;
  readonly latestVersion: string;
  readonly minimumVersion: string;
}): { readonly latestVersion: string; readonly status: BridgeDeviceVersionStatus } {
  const installed = parseVersion(input.installedVersion);
  const latest = parseVersion(input.latestVersion);
  const minimum = parseVersion(input.minimumVersion);
  if (!installed || !latest || !minimum) {
    return { latestVersion: input.latestVersion, status: "unknown" };
  }
  if (installed[0] !== latest[0]) {
    return { latestVersion: input.latestVersion, status: "manual" };
  }
  if (compareVersions(installed, minimum) < 0) {
    return { latestVersion: input.latestVersion, status: "required" };
  }
  return {
    latestVersion: input.latestVersion,
    status:
      compareVersions(installed, latest) < 0 ? "recommended" : "current",
  };
}

export const publishedBridgeUpdate = {
  latestVersion: bridgeUpdateManifest.version,
  minimumVersion: bridgeUpdateManifest.minimum_supported_version,
} as const;
