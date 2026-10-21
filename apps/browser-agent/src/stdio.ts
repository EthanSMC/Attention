import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AccountBoundAuthority } from "./account-authority.js";
import { HttpBrowserAuthority } from "./http-authority.js";
import { createBrowserMcpServer } from "./mcp-server.js";
import { PlaywrightBrowserEngine } from "./playwright-engine.js";
import { BrowserTaskManager } from "./task-manager.js";

/** Installation-owned environment only. Never accept a source URL, grant,
 * OAuth token or executable as a command-line argument. */
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("browser_requires_node_24");
  if (process.env.ATTENTION_BROWSER_CONSENT_VERSION !== "1") throw new Error("browser_consent_required");
  const origin = process.env.ATTENTION_BROWSER_ORIGIN ?? "";
  const directory = process.env.ATTENTION_BROWSER_STATE_DIRECTORY ?? join(homedir(), ".attention");
  if (!isAbsolute(directory) || process.platform !== "darwin") throw new Error("browser_unavailable");
  const entryPath = await realpath(fileURLToPath(import.meta.url));
  const entrySha256 = createHash("sha256").update(await readFile(entryPath)).digest("hex");
  const checkConsent = async () => {
    const file = await open(join(directory, "browser/consent.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("browser_consent_required");
      const receipt = JSON.parse(await file.readFile("utf8"));
      if (receipt.schemaVersion !== 1 || receipt.consentVersion !== 1 || receipt.origin !== origin || receipt.stateDirectory !== directory ||
        receipt.entryPath !== entryPath || receipt.entrySha256 !== entrySha256) throw new Error("browser_consent_required");
    } finally { await file.close(); }
  };
  await checkConsent();
  const remote = new HttpBrowserAuthority(origin, null);
  const manager = new BrowserTaskManager(new AccountBoundAuthority(remote, new URL(origin).origin, directory, checkConsent), new PlaywrightBrowserEngine(directory));
  const server = createBrowserMcpServer(manager), transport = new StdioServerTransport();
  let stopping = false;
  const consentTimer = setInterval(() => { void checkConsent().catch(() => manager.shutdown()).catch(() => {}); }, 1000);
  consentTimer.unref();
  const stop = async () => {
    if (stopping) return; stopping = true;
    clearInterval(consentTimer);
    const deadline = setTimeout(() => process.exit(1), 3000); deadline.unref();
    await manager.shutdown().catch(() => {}); await server.close().catch(() => {});
    clearTimeout(deadline);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  transport.onclose = () => { void stop(); };
  await server.connect(transport);
}

main().catch(() => {
  // Never print raw errors: browser/HTTP errors can contain a URL or credential.
  process.stderr.write("Attention dedicated browser unavailable; check explicit browser consent and installation configuration.\n");
  process.exitCode = 1;
});
