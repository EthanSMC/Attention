import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { channelStateDirectory } from "./state";

export interface ChannelLock {
  readonly path: string;
  release(): Promise<void>;
}

interface LockOptions {
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly pid?: number;
}

export function channelLockPath(baseDirectory?: string): string {
  return join(channelStateDirectory(baseDirectory), "bridge.lock");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function storedPid(contents: string): number | null {
  try {
    const parsed = JSON.parse(contents) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid)
      ? parsed.pid
      : null;
  } catch {
    const parsed = Number(contents.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
}

export async function acquireChannelLock(
  baseDirectory?: string,
  options: LockOptions = {},
): Promise<ChannelLock | null> {
  const path = channelLockPath(baseDirectory);
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  const contents = `${JSON.stringify({ nonce: randomUUID(), pid })}\n`;
  await mkdir(channelStateDirectory(baseDirectory), {
    mode: 0o700,
    recursive: true,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.close();
      return {
        path,
        async release() {
          try {
            if ((await readFile(path, "utf8")) === contents) {
              await rm(path, { force: true });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingPid: number | null;
      try {
        existingPid = storedPid(await readFile(path, "utf8"));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (existingPid !== null && isProcessAlive(existingPid)) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}
