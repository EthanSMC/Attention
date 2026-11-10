import { cp, lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

function excluded(path: string): boolean {
  return path.split(sep).some(part => part.startsWith(".env") || [".git", ".npmrc", ".netrc"].includes(part));
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Check metadata before copying: never follow a link to a host dependency or private file. */
export async function assertStandaloneLinksContained(directory: string): Promise<void> {
  const root = await realpath(directory);
  async function visit(path: string): Promise<void> {
    if (excluded(relative(root, path))) return;
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const lexical = resolve(path, "..", target);
      if (isAbsolute(target) || !inside(root, lexical) || excluded(relative(root, lexical))) {
        throw new Error(`Unsafe standalone symlink: ${relative(root, path)}`);
      }
      const resolved = await realpath(path);
      if (!inside(root, resolved) || excluded(relative(root, resolved))) {
        throw new Error(`Standalone symlink escapes the packaged tree: ${relative(root, path)}`);
      }
    } else if (entry.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    }
  }
  await visit(root);
}

/** Preserve pnpm's relative package links exactly, so Node resolves sibling dependencies correctly. */
export async function copyWebsiteStandalone(input: {
  standalone: string; staticFiles: string; publicFiles: string; destination: string;
}): Promise<void> {
  // Validate all inputs before any copy. Assets must not smuggle host files through links either.
  for (const directory of [input.standalone, input.staticFiles, input.publicFiles])
    await assertStandaloneLinksContained(directory);
  const options = { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: (source: string) => !excluded(basename(source)) };
  await cp(input.standalone, input.destination, options);
  await cp(input.staticFiles, join(input.destination, "apps/web/.next/static"), options);
  await cp(input.publicFiles, join(input.destination, "apps/web/public"), options);
  await assertStandaloneLinksContained(input.destination);
}
