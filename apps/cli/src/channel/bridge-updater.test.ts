import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
  type BridgeUpdateManifest,
} from "../bridge-update-contract";
import {
  bootstrapManagedBridge,
  loadManagedBridgeUpdateState,
} from "./managed-bridge";
import { checkAndStageBridgeUpdate } from "./bridge-updater";

const temporaryDirectories: string[] = [];

function responseWithUrl(body: BodyInit, url: string, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

async function setup(): Promise<{
  home: string;
  manifest: BridgeUpdateManifest;
  candidate: Buffer;
}> {
  const home = await mkdtemp(join(tmpdir(), "attention-updater-"));
  temporaryDirectories.push(home);
  const current = join(home, "attention-0.3.5.mjs");
  await writeFile(current, "#!/usr/bin/env node\n", { mode: 0o700 });
  await bootstrapManagedBridge({
    currentArtifactPath: current,
    homeDirectory: home,
    permissionProfileSha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
    version: "0.3.5",
  });
  const candidate = Buffer.from(`#!/usr/bin/env node
if (process.argv.includes("--bridge-update-probe")) {
  console.log(JSON.stringify({ permission_profile_sha256: ${JSON.stringify(ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256)}, version: "0.3.7" }));
}
`);
  return {
    candidate,
    home,
    manifest: {
      artifact_path: "/cli/attention-0.3.7.mjs",
      minimum_supported_version: "0.3.5",
      node: ">=22.16.0",
      permission_profile_sha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      schema_version: 2,
      sha256: createHash("sha256").update(candidate).digest("hex"),
      version: "0.3.7",
    },
  };
}

describe("Bridge update staging", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (path) =>
        await rm(path, { force: true, recursive: true }),
      ),
    );
  });

  it("downloads, verifies, probes, and atomically stages a compatible release", async () => {
    const { candidate, home, manifest } = await setup();
    const result = await checkAndStageBridgeUpdate({
      currentPermissionProfileSha256:
        ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      currentVersion: "0.3.5",
      fetchImpl: async (input) => {
        const url = String(input);
        return url.endsWith("manifest.json")
          ? responseWithUrl(JSON.stringify(manifest), url, {
              headers: { "content-type": "application/json" },
              status: 200,
            })
          : responseWithUrl(candidate.toString("utf8"), url, {
              headers: {
                "content-length": String(candidate.byteLength),
                "content-type": "text/javascript",
              },
              status: 200,
            });
      },
      homeDirectory: home,
      nodeExecutable: process.execPath,
      origin: "https://attention.example",
    });
    const state = await loadManagedBridgeUpdateState(home);

    expect(result).toEqual({ status: "staged", version: "0.3.7" });
    expect(state).toMatchObject({
      current: { version: "0.3.7" },
      pending: { version: "0.3.7" },
      previous: { version: "0.3.5" },
      status: "restarting",
    });
    expect(
      createHash("sha256")
        .update(await readFile(state.current.artifactPath))
        .digest("hex"),
    ).toBe(manifest.sha256);
  });

  it("does not download or execute a release whose permission profile changed", async () => {
    const { candidate, home, manifest } = await setup();
    let requests = 0;
    const result = await checkAndStageBridgeUpdate({
      currentPermissionProfileSha256:
        ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      currentVersion: "0.3.5",
      fetchImpl: async (input) => {
        requests += 1;
        const url = String(input);
        return responseWithUrl(
          JSON.stringify({ ...manifest, permission_profile_sha256: "b".repeat(64) }),
          url,
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      },
      homeDirectory: home,
      nodeExecutable: process.execPath,
      origin: "https://attention.example",
    });

    expect(result).toEqual({ status: "consent_required", version: "0.3.7" });
    expect(requests).toBe(1);
    expect(await loadManagedBridgeUpdateState(home)).toMatchObject({
      current: { version: "0.3.5" },
      pending: null,
      status: "consent_required",
    });
    expect(candidate.byteLength).toBeGreaterThan(0);
  });

  it("does not download a release that requires a newer Node runtime", async () => {
    const { home, manifest } = await setup();
    let requests = 0;
    const result = await checkAndStageBridgeUpdate({
      currentPermissionProfileSha256:
        ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      currentVersion: "0.3.5",
      fetchImpl: async (input) => {
        requests += 1;
        const url = String(input);
        return responseWithUrl(
          JSON.stringify({ ...manifest, node: ">=99.0.0" }),
          url,
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      },
      homeDirectory: home,
      nodeExecutable: process.execPath,
      nodeVersion: "24.0.0",
      origin: "https://attention.example",
    });

    expect(result).toEqual({
      errorCode: "node_version_unsupported",
      status: "error",
    });
    expect(requests).toBe(1);
  });

  it.each([
    { name: "cross-origin response", mutate: "origin" as const },
    { name: "digest mismatch", mutate: "digest" as const },
    { name: "candidate probe mismatch", mutate: "probe" as const },
  ])("keeps the current release after $name", async ({ mutate }) => {
    const { candidate, home, manifest } = await setup();
    const badCandidate =
      mutate === "probe"
        ? Buffer.from(candidate.toString("utf8").replace('version: "0.3.7"', 'version: "9.9.9"'))
        : candidate;
    const servedManifest = {
      ...manifest,
      ...(mutate === "digest" ? { sha256: "c".repeat(64) } : {}),
      ...(mutate === "probe"
        ? { sha256: createHash("sha256").update(badCandidate).digest("hex") }
        : {}),
    };
    const result = await checkAndStageBridgeUpdate({
      currentPermissionProfileSha256:
        ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      currentVersion: "0.3.5",
      fetchImpl: async (input) => {
        const requested = String(input);
        const responseUrl =
          mutate === "origin" && !requested.endsWith("manifest.json")
            ? "https://cdn.example/attention.mjs"
            : requested;
        return requested.endsWith("manifest.json")
          ? responseWithUrl(JSON.stringify(servedManifest), requested, {
              headers: { "content-type": "application/json" },
              status: 200,
            })
          : responseWithUrl(badCandidate.toString("utf8"), responseUrl, {
              headers: { "content-type": "text/javascript" },
              status: 200,
            });
      },
      homeDirectory: home,
      nodeExecutable: process.execPath,
      origin: "https://attention.example",
    });

    expect(result.status).toBe("error");
    expect(await loadManagedBridgeUpdateState(home)).toMatchObject({
      current: { version: "0.3.5" },
      pending: null,
      status: "error",
    });
  });
});
