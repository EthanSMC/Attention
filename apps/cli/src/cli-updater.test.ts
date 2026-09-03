import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeUpdateManifest } from "./bridge-update-contract";
import { type CommandRunner } from "./command-runner";
import {
  checkCliUpdateAtStartup,
  updateAttentionCli,
} from "./cli-updater";

const temporaryDirectories: string[] = [];
const artifact = Buffer.from("#!/usr/bin/env node\n");
const manifest: BridgeUpdateManifest = {
  artifact_path: "/cli/attention-0.3.13.mjs",
  minimum_supported_version: "0.3.5",
  node: ">=22.16.0",
  permission_profile_sha256: "a".repeat(64),
  schema_version: 2,
  sha256: createHash("sha256").update(artifact).digest("hex"),
  version: "0.3.13",
};

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "attention-cli-update-"));
  temporaryDirectories.push(path);
  return path;
}

function responseAt(url: string, value = manifest): Response {
  const response = new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function successfulFetch(requested: string[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    requested.push(url);
    return responseAt(url);
  };
}

describe("CLI update startup check", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (path) =>
        await rm(path, { force: true, recursive: true }),
      ),
    );
  });

  it("skips the first check when no explicit, environment, or saved origin exists", async () => {
    const homeDirectory = await temporaryHome();
    let requested = false;

    const notice = await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      fetchImpl: async () => {
        requested = true;
        throw new Error("must not fetch");
      },
      homeDirectory,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(notice).toBeNull();
    expect(requested).toBe(false);
  });

  it("uses explicit, environment, then the last validated saved origin", async () => {
    const explicitHome = await temporaryHome();
    const environmentHome = await temporaryHome();
    const savedHome = await temporaryHome();
    const requested: string[] = [];
    const fetchImpl = successfulFetch(requested);
    const first = new Date("2026-09-03T00:00:00.000Z");
    const later = new Date("2026-09-05T00:00:00.000Z");

    await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: { ATTENTION_ORIGIN: "https://env-ignored.example" },
      explicitOrigin: "https://explicit.example/",
      fetchImpl,
      homeDirectory: explicitHome,
      nodeVersion: "24.0.0",
      now: () => first,
    });
    await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: { ATTENTION_ORIGIN: "https://env.example" },
      fetchImpl,
      homeDirectory: environmentHome,
      nodeVersion: "24.0.0",
      now: () => first,
    });
    await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://saved.example",
      fetchImpl,
      homeDirectory: savedHome,
      nodeVersion: "24.0.0",
      now: () => first,
    });
    await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      fetchImpl,
      homeDirectory: savedHome,
      nodeVersion: "24.0.0",
      now: () => later,
    });

    expect(requested).toEqual([
      "https://explicit.example/cli/manifest.json",
      "https://env.example/cli/manifest.json",
      "https://saved.example/cli/manifest.json",
      "https://saved.example/cli/manifest.json",
    ]);
  });

  it("checks once per origin every 24 hours and returns the cached reminder meanwhile", async () => {
    const homeDirectory = await temporaryHome();
    const requested: string[] = [];
    const fetchImpl = successfulFetch(requested);

    const first = await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://attention.example",
      fetchImpl,
      homeDirectory,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    const second = await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      fetchImpl,
      homeDirectory,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-03T23:59:59.999Z"),
    });

    expect(first).toEqual({
      currentVersion: "0.3.12",
      latestVersion: "0.3.13",
    });
    expect(second).toEqual(first);
    expect(requested).toHaveLength(1);
    const statePath = join(homeDirectory, ".attention", "cli-update", "state.json");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      trustedOrigin: "https://attention.example",
    });
  });

  it("checks a changed explicit origin immediately without mixing its reminder", async () => {
    const homeDirectory = await temporaryHome();
    const requested: string[] = [];
    const fetchImpl = successfulFetch(requested);

    await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://first.example",
      fetchImpl,
      homeDirectory,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    const notice = await checkCliUpdateAtStartup({
      currentVersion: "0.3.13",
      environment: {},
      explicitOrigin: "https://second.example",
      fetchImpl,
      homeDirectory,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-03T01:00:00.000Z"),
    });

    expect(requested).toEqual([
      "https://first.example/cli/manifest.json",
      "https://second.example/cli/manifest.json",
    ]);
    expect(notice).toBeNull();
  });

  it("silently preserves a validated reminder when a due network check fails", async () => {
    const homeDirectory = await temporaryHome();
    const requested: string[] = [];

    await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://attention.example",
      fetchImpl: successfulFetch(requested),
      homeDirectory,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    const notice = await checkCliUpdateAtStartup({
      currentVersion: "0.3.12",
      environment: {},
      fetchImpl: async () => {
        throw new Error("offline");
      },
      homeDirectory,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-05T00:00:00.000Z"),
    });

    expect(notice).toEqual({
      currentVersion: "0.3.12",
      latestVersion: "0.3.13",
    });
  });

  it("does not remind about a release unsupported by the running Node version", async () => {
    const homeDirectory = await temporaryHome();
    const fetchImpl: typeof fetch = async (input) =>
      responseAt(String(input), { ...manifest, node: ">=99.0.0" });

    await expect(
      checkCliUpdateAtStartup({
        currentVersion: "0.3.12",
        environment: {},
        explicitOrigin: "https://attention.example",
        fetchImpl,
        homeDirectory,
        nodeVersion: "24.0.0",
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });
});

interface ManagedFixture {
  readonly artifact: Buffer;
  readonly commandPath: string;
  readonly currentArtifactPath: string;
  readonly fetchImpl: typeof fetch;
  readonly homeDirectory: string;
  readonly manifest: BridgeUpdateManifest;
  readonly originalTarget: string;
}

async function managedFixture(options: {
  readonly candidateVersion?: string;
  readonly probeVersion?: string;
} = {}): Promise<ManagedFixture> {
  const homeDirectory = await temporaryHome();
  const commandPath = join(homeDirectory, ".local", "bin", "attention");
  const currentArtifactPath = join(
    homeDirectory,
    ".local",
    "share",
    "attention",
    "attention-0.3.12.mjs",
  );
  await mkdir(dirname(commandPath), { recursive: true });
  await mkdir(dirname(currentArtifactPath), { recursive: true });
  await writeFile(currentArtifactPath, "#!/usr/bin/env node\n", { mode: 0o700 });
  const originalTarget = relative(dirname(commandPath), currentArtifactPath);
  await symlink(originalTarget, commandPath);

  const candidateVersion = options.candidateVersion ?? "0.3.13";
  const probeVersion = options.probeVersion ?? candidateVersion;
  const candidate = Buffer.from(`#!/usr/bin/env node
if (process.argv.includes("--bridge-update-probe")) {
  console.log(JSON.stringify({ permission_profile_sha256: "${"a".repeat(64)}", version: "${probeVersion}" }));
}
`);
  const updateManifest: BridgeUpdateManifest = {
    ...manifest,
    artifact_path: `/cli/attention-${candidateVersion}.mjs`,
    permission_profile_sha256: "a".repeat(64),
    sha256: createHash("sha256").update(candidate).digest("hex"),
    version: candidateVersion,
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    return url.endsWith("manifest.json")
      ? responseAt(url, updateManifest)
      : (() => {
          const response = new Response(candidate, {
            headers: { "content-length": String(candidate.byteLength) },
            status: 200,
          });
          Object.defineProperty(response, "url", { value: url });
          return response;
        })();
  };
  return {
    artifact: candidate,
    commandPath,
    currentArtifactPath,
    fetchImpl,
    homeDirectory,
    manifest: updateManifest,
    originalTarget,
  };
}

describe("explicit CLI update", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (path) =>
        await rm(path, { force: true, recursive: true }),
      ),
    );
  });

  it("reports a stable error for an invalid explicit origin", async () => {
    const result = await updateAttentionCli({
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "http://not-loopback.example",
      homeDirectory: await temporaryHome(),
      nodeVersion: "24.0.0",
    });

    expect(result).toEqual({
      errorCode: "invalid_origin",
      installationKind: "unsupported",
      status: "error",
    });
  });

  it("writes a probed versioned artifact and atomically switches the managed symlink", async () => {
    const fixture = await managedFixture();

    const result = await updateAttentionCli({
      commandPath: fixture.commandPath,
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://attention.example",
      fetchImpl: fixture.fetchImpl,
      homeDirectory: fixture.homeDirectory,
      nodeExecutable: process.execPath,
      nodeVersion: "24.0.0",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(result).toEqual({
      fromVersion: "0.3.12",
      installationKind: "managed_symlink",
      status: "updated",
      toVersion: "0.3.13",
    });
    const candidatePath = join(
      fixture.homeDirectory,
      ".local",
      "share",
      "attention",
      "attention-0.3.13.mjs",
    );
    expect(await readlink(fixture.commandPath)).toBe(
      relative(dirname(fixture.commandPath), candidatePath),
    );
    expect(await readFile(candidatePath)).toEqual(fixture.artifact);
    expect(await readFile(fixture.currentArtifactPath, "utf8")).toBe(
      "#!/usr/bin/env node\n",
    );
  });

  it("reports current without changing the managed link", async () => {
    const fixture = await managedFixture({ candidateVersion: "0.3.12" });

    const result = await updateAttentionCli({
      commandPath: fixture.commandPath,
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://attention.example",
      fetchImpl: fixture.fetchImpl,
      homeDirectory: fixture.homeDirectory,
      nodeVersion: "24.0.0",
    });

    expect(result).toEqual({ status: "current", version: "0.3.12" });
    expect(await readlink(fixture.commandPath)).toBe(fixture.originalTarget);
  });

  it.each(["digest", "probe", "collision"] as const)(
    "keeps the old command selected after a %s failure",
    async (failure) => {
      const fixture = await managedFixture({
        ...(failure === "probe" ? { probeVersion: "9.9.9" } : {}),
      });
      const candidatePath = join(
        fixture.homeDirectory,
        ".local",
        "share",
        "attention",
        "attention-0.3.13.mjs",
      );
      if (failure === "collision") {
        await writeFile(candidatePath, "different", { mode: 0o700 });
      }
      const fetchImpl: typeof fetch = async (input, init) => {
        const response = await fixture.fetchImpl(input, init);
        if (failure !== "digest" || String(input).endsWith("manifest.json")) {
          return response;
        }
        const tampered = new Response("tampered", { status: 200 });
        Object.defineProperty(tampered, "url", { value: String(input) });
        return tampered;
      };

      const result = await updateAttentionCli({
        commandPath: fixture.commandPath,
        currentVersion: "0.3.12",
        environment: {},
        explicitOrigin: "https://attention.example",
        fetchImpl,
        homeDirectory: fixture.homeDirectory,
        nodeExecutable: process.execPath,
        nodeVersion: "24.0.0",
      });

      expect(result.status).toBe("error");
      expect(await readlink(fixture.commandPath)).toBe(fixture.originalTarget);
    },
  );

  it("aborts when the managed link changes during candidate probing", async () => {
    const fixture = await managedFixture();
    const replacement = join(
      fixture.homeDirectory,
      ".local",
      "share",
      "attention",
      "attention-0.3.10.mjs",
    );
    await writeFile(replacement, "older", { mode: 0o700 });
    const runner: CommandRunner = async () => {
      await rm(fixture.commandPath);
      await symlink(relative(dirname(fixture.commandPath), replacement), fixture.commandPath);
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: JSON.stringify({
          permission_profile_sha256: "a".repeat(64),
          version: "0.3.13",
        }),
        timedOut: false,
      };
    };

    const result = await updateAttentionCli({
      commandPath: fixture.commandPath,
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://attention.example",
      fetchImpl: fixture.fetchImpl,
      homeDirectory: fixture.homeDirectory,
      nodeVersion: "24.0.0",
      runner,
    });

    expect(result).toMatchObject({
      errorCode: "cli_installation_changed",
      status: "error",
    });
    expect(await readlink(fixture.commandPath)).toBe(
      relative(dirname(fixture.commandPath), replacement),
    );
  });

  it("does not overwrite an unmanaged command", async () => {
    const fixture = await managedFixture();
    await rm(fixture.commandPath);
    await writeFile(fixture.commandPath, "package-manager wrapper", { mode: 0o700 });

    const result = await updateAttentionCli({
      commandPath: fixture.commandPath,
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://attention.example",
      fetchImpl: fixture.fetchImpl,
      homeDirectory: fixture.homeDirectory,
      nodeVersion: "24.0.0",
    });

    expect(result).toEqual({
      errorCode: "unsupported_installation",
      installationKind: "unsupported",
      status: "error",
    });
    expect(await readFile(fixture.commandPath, "utf8")).toBe(
      "package-manager wrapper",
    );
  });

  it("treats a missing managed command as an unsupported installation", async () => {
    const homeDirectory = await temporaryHome();
    const commandPath = join(homeDirectory, ".local", "bin", "attention");

    const result = await updateAttentionCli({
      commandPath,
      currentVersion: "0.3.12",
      environment: {},
      explicitOrigin: "https://attention.example",
      fetchImpl: successfulFetch([]),
      homeDirectory,
      nodeVersion: "24.0.0",
    });

    expect(result).toEqual({
      errorCode: "unsupported_installation",
      installationKind: "unsupported",
      status: "error",
    });
  });
});
