import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

interface ResolveHostExecutableOptions {
  readonly applicationDirectories?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    if (!entry.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isOnPath(
  executable: string,
  pathValue: string | undefined,
): Promise<boolean> {
  if (!pathValue) return false;
  for (const directory of pathValue.split(delimiter)) {
    if (directory && await isExecutableFile(join(directory, executable))) {
      return true;
    }
  }
  return false;
}

export async function resolveHostExecutable(
  executable: string,
  options: ResolveHostExecutableOptions = {},
): Promise<string> {
  if (executable !== "codex") return executable;

  const environment = options.environment ?? process.env;
  const configured = environment.ATTENTION_CODEX_EXECUTABLE?.trim();
  if (configured && await isExecutableFile(configured)) return configured;
  if (await isOnPath(executable, environment.PATH)) return executable;
  if ((options.platform ?? process.platform) !== "darwin") return executable;

  const applicationDirectories = options.applicationDirectories ?? [
    "/Applications",
    join(homedir(), "Applications"),
  ];
  for (const applicationDirectory of applicationDirectories) {
    for (const appName of ["Codex.app", "ChatGPT.app"]) {
      const candidate = join(
        applicationDirectory,
        appName,
        "Contents",
        "Resources",
        "codex",
      );
      if (await isExecutableFile(candidate)) return candidate;
    }
  }

  return executable;
}
