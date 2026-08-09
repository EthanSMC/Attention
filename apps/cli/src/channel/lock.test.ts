import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireChannelLock, channelLockPath } from "./lock";

describe("channel single-instance lock", () => {
  const tempDirs: string[] = [];

  const makeTempBase = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "attention-channel-lock-"));
    tempDirs.push(directory);
    return directory;
  };

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("allows only one live bridge instance", async () => {
    const base = await makeTempBase();
    const first = await acquireChannelLock(base, {
      isProcessAlive: () => true,
      pid: 123,
    });
    expect(first).not.toBeNull();
    await expect(
      acquireChannelLock(base, { isProcessAlive: () => true, pid: 456 }),
    ).resolves.toBeNull();
    await first?.release();
    expect(
      await acquireChannelLock(base, { isProcessAlive: () => true, pid: 456 }),
    ).not.toBeNull();
  });

  it("recovers a stale lock left by a crashed process", async () => {
    const base = await makeTempBase();
    await writeFile(channelLockPath(base), "999999\n", "utf8").catch(
      async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(base, ".attention", "channel"), { recursive: true });
        await writeFile(channelLockPath(base), "999999\n", "utf8");
      },
    );
    const lock = await acquireChannelLock(base, {
      isProcessAlive: () => false,
      pid: 123,
    });
    expect(lock).not.toBeNull();
    await lock?.release();
  });
});
