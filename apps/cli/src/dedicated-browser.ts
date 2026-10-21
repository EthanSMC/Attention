import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256 } from "./bridge-update-contract";

export const DEDICATED_BROWSER_CONSENT_VERSION = 1;
export const DEDICATED_BROWSER_DISCLOSURE = "专用浏览器独立保存验证会话，不读取日常浏览器资料。请求文章的正文会进入 Codex 上下文，生成结果仅保存到你自己的 Attention 收藏；验证需你在该专用窗口操作。不授予通用浏览器、任意脚本、上传下载或支付权限。不自动安装浏览器依赖，也不重启当前 Bridge。";
export interface DedicatedBrowserConfiguration {
  readonly schemaVersion: 1;
  readonly consentVersion: 1;
  readonly origin: string;
  readonly entryPath: string;
  readonly entrySha256: string;
  readonly nodePath: string;
  readonly stateDirectory: string;
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const receiptPath = (home: string) => join(home, ".attention/browser/consent.json");
async function directory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
    (process.getuid && stat.uid !== process.getuid())) throw new Error("browser_configuration_permissions");
}
async function read(path: string, max: number, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max || (stat.mode & (privateFile ? 0o077 : 0o022)) ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error("browser_configuration_permissions");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
    throw new Error("browser_origin_invalid");
  return url.origin;
}
async function validateArtifact(entryPath: string) {
  if (!isAbsolute(entryPath) || !entryPath.endsWith("/dist/stdio.js")) throw new Error("browser_artifact_invalid");
  const entry = await realpath(entryPath);
  const pkg = JSON.parse(await read(join(dirname(dirname(entry)), "package.json"), 16_384));
  if (pkg.name !== "@attention/browser-agent" || pkg.version !== "0.1.0" || pkg.dependencies?.playwright !== "1.62.0" ||
    pkg.dependencies?.["@modelcontextprotocol/sdk"] !== "1.30.0" || pkg.dependencies?.zod !== "4.4.3") throw new Error("browser_artifact_invalid");
  return { entryPath: entry, entrySha256: sha(await read(entry, 2 * 1024 * 1024)) };
}
export async function configureDedicatedBrowser(options: { entryPath: string; origin: string; apply: boolean; home?: string }) {
  if (process.platform !== "darwin") throw new Error("browser_platform_unavailable");
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("browser_requires_node_24");
  const home = await realpath(options.home ?? homedir()), pinnedOrigin = origin(options.origin);
  const artifact = await validateArtifact(options.entryPath);
  const config: DedicatedBrowserConfiguration = { schemaVersion: 1, consentVersion: 1, origin: pinnedOrigin,
    ...artifact, nodePath: await realpath(process.execPath), stateDirectory: join(home, ".attention") };
  if (options.apply) {
    await directory(config.stateDirectory); await directory(join(config.stateDirectory, "browser"));
    const path = receiptPath(home), temporary = path + "." + process.pid + ".tmp";
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(config) + "\n"); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
  }
  return { applied: options.apply, disclosure: DEDICATED_BROWSER_DISCLOSURE, receiptPath: receiptPath(home) };
}
export async function loadDedicatedBrowser(originValue: string, home = homedir()): Promise<DedicatedBrowserConfiguration | undefined> {
  let raw: string;
  try { raw = await read(receiptPath(home), 16_384, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value = JSON.parse(raw) as DedicatedBrowserConfiguration;
  if (value.schemaVersion !== 1 || value.consentVersion !== 1 || value.origin !== origin(originValue) ||
    value.stateDirectory !== join(await realpath(home), ".attention") || !isAbsolute(value.nodePath) ||
    typeof value.entrySha256 !== "string") throw new Error("browser_consent_invalid");
  await directory(value.stateDirectory); await directory(join(value.stateDirectory, "browser"));
  const artifact = await validateArtifact(value.entryPath);
  if (artifact.entrySha256 !== value.entrySha256) throw new Error("browser_reconsent_required");
  return value;
}
export async function disableDedicatedBrowser(home = homedir()) {
  // Remove only this permission receipt. Profile, grants and WeChat state are untouched.
  await unlink(receiptPath(home)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}
export function browserPermissionFingerprint(config: DedicatedBrowserConfiguration) {
  return sha(JSON.stringify([ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256, config.consentVersion, config.origin, config.entrySha256]));
}
