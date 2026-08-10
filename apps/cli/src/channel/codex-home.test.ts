import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  channelCodexHomeDirectory,
  prepareChannelCodexHome,
} from "./codex-home";

async function withTemporaryDirectory(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "attention-codex-home-test-"));
  try {
    await run(path);
  } finally {
    await rm(path, { force: true, recursive: true });
  }
}

describe("prepareChannelCodexHome", () => {
  it("creates a restricted, auth-only Codex home without copying credentials", async () => {
    await withTemporaryDirectory(async (baseDirectory) => {
      const sourceCodexHome = join(baseDirectory, "source-codex");
      await mkdir(sourceCodexHome, { recursive: true });
      const sourceAuthPath = join(sourceCodexHome, "auth.json");
      await writeFile(sourceAuthPath, '{"local":"credential"}', {
        mode: 0o600,
      });

      const codexHome = await prepareChannelCodexHome({
        baseDirectory,
        platform: "darwin",
        sourceCodexHome,
      });

      expect(codexHome).toBe(channelCodexHomeDirectory(baseDirectory));
      expect((await stat(codexHome)).mode & 0o777).toBe(0o700);
      const linkedAuthPath = join(codexHome, "auth.json");
      expect((await lstat(linkedAuthPath)).isSymbolicLink()).toBe(true);
      expect(resolve(codexHome, await readlink(linkedAuthPath))).toBe(
        sourceAuthPath,
      );
    });
  });

  it("uses a hard link on Windows so setup does not require symlink privilege", async () => {
    await withTemporaryDirectory(async (baseDirectory) => {
      const sourceCodexHome = join(baseDirectory, "source-codex");
      await mkdir(sourceCodexHome, { recursive: true });
      const sourceAuthPath = join(sourceCodexHome, "auth.json");
      await writeFile(sourceAuthPath, '{"local":"credential"}', {
        mode: 0o600,
      });

      const codexHome = await prepareChannelCodexHome({
        baseDirectory,
        platform: "win32",
        sourceCodexHome,
      });

      const source = await stat(sourceAuthPath);
      const linked = await stat(join(codexHome, "auth.json"));
      expect(linked.ino).toBe(source.ino);
      expect(linked.dev).toBe(source.dev);
    });
  });

  it("is idempotent but refuses to overwrite unrelated credentials", async () => {
    await withTemporaryDirectory(async (baseDirectory) => {
      const sourceCodexHome = join(baseDirectory, "source-codex");
      await mkdir(sourceCodexHome, { recursive: true });
      await writeFile(join(sourceCodexHome, "auth.json"), "source", {
        mode: 0o600,
      });

      await prepareChannelCodexHome({
        baseDirectory,
        platform: "darwin",
        sourceCodexHome,
      });
      await expect(
        prepareChannelCodexHome({
          baseDirectory,
          platform: "darwin",
          sourceCodexHome,
        }),
      ).resolves.toBe(channelCodexHomeDirectory(baseDirectory));

      const isolatedAuthPath = join(
        channelCodexHomeDirectory(baseDirectory),
        "auth.json",
      );
      await rm(isolatedAuthPath, { force: true });
      await writeFile(isolatedAuthPath, "unrelated", { mode: 0o600 });

      await expect(
        prepareChannelCodexHome({
          baseDirectory,
          platform: "darwin",
          sourceCodexHome,
        }),
      ).rejects.toThrow(/refusing to overwrite/iu);
    });
  });

  it("fails with an actionable message when Codex is not logged in", async () => {
    await withTemporaryDirectory(async (baseDirectory) => {
      await expect(
        prepareChannelCodexHome({
          baseDirectory,
          platform: "darwin",
          sourceCodexHome: join(baseDirectory, "missing-codex"),
        }),
      ).rejects.toThrow(/codex login/iu);
    });
  });
});
