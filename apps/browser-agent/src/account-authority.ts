import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserAuthority } from "./task-manager.js";
import { BrowserTaskError, BrowserGrantSchema } from "./contracts.js";
import { z } from "zod";

const bindingSchema = z.object({ schema_version: z.literal(1), origin: z.string().url(), account_id: z.string().uuid() }).strict();

export async function ensurePrivateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
    (process.getuid && stat.uid !== process.getuid())) throw new BrowserTaskError("browser_unavailable");
}

/** The first server-validated grant binds an explicitly enabled dedicated
 * profile to an account AND issuer. A different identity requires a separate
 * profile; never copy or silently reuse the old identity's browser session. */
export class AccountBoundAuthority implements BrowserAuthority {
  constructor(private readonly authority: BrowserAuthority, private readonly origin: string, private readonly directory: string,
    private readonly checkConsent?: () => Promise<void>) {}
  async resolve(token: string, signal: AbortSignal) {
    await this.checkConsent?.();
    const grant = BrowserGrantSchema.parse(await this.authority.resolve(token, signal));
    signal.throwIfAborted();
    if (grant.expires_at <= Date.now()) throw new BrowserTaskError("task_expired");
    const root = resolve(this.directory), browserRoot = join(root, "browser");
    await ensurePrivateDirectory(root); await ensurePrivateDirectory(browserRoot);
    const path = join(browserRoot, "account-binding.json");
    const expected = { schema_version: 1 as const, origin: this.origin, account_id: grant.account_id };
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(expected) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) ||
        (process.getuid && stat.uid !== process.getuid())) throw new BrowserTaskError("permission_revoked");
      const value = bindingSchema.parse(JSON.parse(await handle.readFile("utf8")));
      if (value.account_id !== grant.account_id || value.origin !== this.origin) throw new BrowserTaskError("permission_revoked");
    } finally { await handle.close(); }
    signal.throwIfAborted();
    await this.checkConsent?.();
    return grant;
  }
}
