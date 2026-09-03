import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readlink,
  stat,
  symlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { channelStateDirectory } from "./state";

export interface PrepareChannelCodexHomeOptions {
  readonly baseDirectory?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly sourceCodexHome?: string;
}

export function channelCodexHomeDirectory(baseDirectory?: string): string {
  return join(channelStateDirectory(baseDirectory), "codex-home");
}

function sourceCodexHome(options: PrepareChannelCodexHomeOptions): string {
  return (
    options.sourceCodexHome ??
    process.env.CODEX_HOME ??
    join(options.homeDirectory ?? homedir(), ".codex")
  );
}

async function sameLinkedFile(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

async function existingDestinationMatches(
  destination: string,
  source: string,
): Promise<boolean> {
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink()) {
      return resolve(dirname(destination), await readlink(destination)) === source;
    }
    return await sameLinkedFile(destination, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function rejectHomeScopedMcpCredentials(
  destinationHome: string,
): Promise<void> {
  for (const name of [".credentials.json", "secrets"] as const) {
    try {
      await lstat(join(destinationHome, name));
      throw new Error(
        `Attention found home-scoped MCP credentials in the isolated Codex home (${name}); refusing to use or overwrite them. Reauthorize through attention configure codex --apply --login after upgrading Codex.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Builds an auth-only CODEX_HOME for the local Channel runtime.
 *
 * The user's auth file stays on-device and is linked rather than parsed or
 * copied. The isolated home intentionally does not inherit config.toml,
 * skills, plugins, or unrelated MCP definitions. The resident adapter still
 * performs a fail-closed `mcpServerStatus/list` check before accepting turns.
 */
export async function prepareChannelCodexHome(
  options: PrepareChannelCodexHomeOptions = {},
): Promise<string> {
  const sourceHome = resolve(sourceCodexHome(options));
  const sourceAuthPath = join(sourceHome, "auth.json");
  try {
    await access(sourceAuthPath, constants.R_OK);
  } catch {
    throw new Error(
      `Codex login was not found at ${sourceAuthPath}. Run codex login, then retry Attention Channel setup.`,
    );
  }

  const destinationHome = resolve(
    channelCodexHomeDirectory(options.baseDirectory),
  );
  await mkdir(destinationHome, { mode: 0o700, recursive: true });
  await chmod(destinationHome, 0o700);
  await rejectHomeScopedMcpCredentials(destinationHome);
  const destinationAuthPath = join(destinationHome, "auth.json");

  if (sourceAuthPath === destinationAuthPath) return destinationHome;
  if (await existingDestinationMatches(destinationAuthPath, sourceAuthPath)) {
    return destinationHome;
  }
  try {
    await lstat(destinationAuthPath);
    throw new Error(
      `Attention found unrelated credentials at ${destinationAuthPath}; refusing to overwrite them.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if ((options.platform ?? process.platform) === "win32") {
    await link(sourceAuthPath, destinationAuthPath);
  } else {
    await symlink(sourceAuthPath, destinationAuthPath, "file");
  }
  return destinationHome;
}
