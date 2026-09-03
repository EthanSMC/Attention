import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { execBrain } from "./channel/brain";
import { runCommand } from "./command-runner";
import { resolveHostExecutable } from "./host-executable";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("host executable discovery", () => {
  it("resolves the Codex binary bundled in ChatGPT when codex is absent from PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "attention-cli-apps-"));
    temporaryDirectories.push(root);
    const applicationsDirectory = join(root, "Applications");
    const bundledCodex = join(
      applicationsDirectory,
      "ChatGPT.app",
      "Contents",
      "Resources",
      "codex",
    );
    await mkdir(dirname(bundledCodex), { recursive: true });
    await writeFile(bundledCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(bundledCodex, 0o755);

    await expect(
      resolveHostExecutable("codex", {
        applicationDirectories: [applicationsDirectory],
        environment: { PATH: "" },
        platform: "darwin",
      }),
    ).resolves.toBe(bundledCodex);
  });

  it("uses an explicitly configured Codex executable for host commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "attention-cli-codex-"));
    temporaryDirectories.push(root);
    const codexExecutable = join(root, "codex");
    await writeFile(codexExecutable, "#!/bin/sh\nprintf 'bundled codex\\n'\n", {
      mode: 0o755,
    });
    await chmod(codexExecutable, 0o755);
    vi.stubEnv("ATTENTION_CODEX_EXECUTABLE", codexExecutable);
    vi.stubEnv("PATH", "");

    const result = await runCommand({ executable: "codex", args: [] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bundled codex");
  });

  it("uses the resolved Codex executable for bridge brain invocations", async () => {
    const root = await mkdtemp(join(tmpdir(), "attention-cli-brain-"));
    temporaryDirectories.push(root);
    const binaryDirectory = join(root, "bin");
    await mkdir(binaryDirectory);
    const codexExecutable = join(binaryDirectory, "codex");
    await writeFile(codexExecutable, "#!/bin/sh\nprintf 'resident codex\\n'\n", {
      mode: 0o755,
    });
    await chmod(codexExecutable, 0o755);
    vi.stubEnv("ATTENTION_CODEX_EXECUTABLE", codexExecutable);
    vi.stubEnv("PATH", "/usr/bin:/bin");

    const result = await execBrain({
      args: [],
      cwd: root,
      executable: "codex",
      timeoutMs: 1_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("resident codex\n");
  });
});
