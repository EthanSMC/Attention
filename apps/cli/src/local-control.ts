import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CONTROL_ACTIONS = ["check", "request", "cancel", "defer"] as const;
export type ControlAction = typeof CONTROL_ACTIONS[number];
export const CONTROL_TTL_MS = 10 * 60_000;
export const controlId = () => randomBytes(16).toString("hex");
const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
const binding = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const version = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export const localControlPaths = (home = homedir()) => {
  const root = join(resolve(home), ".attention", "control");
  return { root, requests: join(root, "requests"), results: join(root, "results"), status: join(root, "status.json"), workspace: join(resolve(home), ".attention", "codex-workspace") };
};
export interface ControlRequest { schemaVersion: 1; id: string; action: ControlAction; instanceId: string; binding: string; createdAt: number }
export interface ControlSnapshot {
  schemaVersion: 1; instanceId: string; binding: string | null; pid: number; updatedAt: number;
  runningVersion: string; service: "running" | "stopped"; runtime: string; mcp: string;
  update: { candidateVersion: string | null; phase: string; latestVerified: { version: string; checkedAt: number } | null; lastErrorCode: string | null };
}
export interface ControlResult {
  schemaVersion: 1; id: string; instanceId: string; action: ControlAction | null;
  status: "accepted" | "not_started" | "already_processed" | "rejected";
  code: string; processedAt: number;
}
export function parseControlResult(raw: unknown): ControlResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as ControlResult;
  return Object.keys(r).sort().join() === "action,code,id,instanceId,processedAt,schemaVersion,status" && r.schemaVersion === 1 && id(r.id) && id(r.instanceId) && (r.action === null || CONTROL_ACTIONS.includes(r.action)) && ["accepted", "not_started", "already_processed", "rejected"].includes(r.status) && typeof r.code === "string" && /^[a-z_]{1,80}$/.test(r.code) && finite(r.processedAt) ? r : null;
}
export function parseControlRequest(raw: unknown): ControlRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as ControlRequest;
  return Object.keys(r).sort().join() === "action,binding,createdAt,id,instanceId,schemaVersion" && r.schemaVersion === 1 && id(r.id) && id(r.instanceId) && binding(r.binding) && finite(r.createdAt) && CONTROL_ACTIONS.includes(r.action) ? r : null;
}
export async function assertControlDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw new Error("control_path_unsafe");
}
export async function prepareLocalControl(home = homedir()): Promise<void> {
  const paths = localControlPaths(home);
  for (const path of [join(resolve(home), ".attention"), paths.root, paths.requests, paths.results, paths.workspace]) {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertControlDirectory(path);
  }
}
/** Bounded and no-follow: the Agent can write request files but cannot redirect privileged I/O. */
export async function readControlJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw new Error("control_file_unsafe");
    const bytes = Buffer.alloc(16_385); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16_384) throw new Error("control_file_unsafe");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}
export async function writeControlJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${controlId()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function loadSnapshot(home: string): Promise<ControlSnapshot> {
  const paths = localControlPaths(home);
  await assertControlDirectory(join(resolve(home), ".attention")); await assertControlDirectory(paths.root);
  const s = await readControlJson(paths.status) as ControlSnapshot;
  if (!s || s.schemaVersion !== 1 || !id(s.instanceId) || !(s.binding === null || binding(s.binding)) || !Number.isSafeInteger(s.pid) || s.pid <= 0 || !finite(s.updatedAt) || !version(s.runningVersion) || !s.update || typeof s.update.phase !== "string" || !(s.update.candidateVersion === null || version(s.update.candidateVersion)) || typeof s.runtime !== "string" || typeof s.mcp !== "string") throw new Error("control_snapshot_invalid");
  if (!/^[a-z_]{1,64}$/.test(s.runtime) || !/^[a-z_]{1,64}$/.test(s.mcp) || !/^[a-z_]{1,64}$/.test(s.update.phase) || !(s.update.lastErrorCode === null || typeof s.update.lastErrorCode === "string" && /^[a-z_]{1,80}$/.test(s.update.lastErrorCode)) || !(s.update.latestVerified === null || s.update.latestVerified && version(s.update.latestVerified.version) && finite(s.update.latestVerified.checkedAt))) throw new Error("control_snapshot_invalid");
  if (s.service !== "running" && s.service !== "stopped") throw new Error("control_snapshot_invalid");
  return s;
}
function isOnline(s: ControlSnapshot, now: number): boolean | null {
  if (s.service === "stopped" || now < s.updatedAt || now - s.updatedAt > CONTROL_TTL_MS) return false;
  try { process.kill(s.pid, 0); return true; } catch (error) {
    // Seatbelt may deny even signal 0. This is unknown liveness, not a dead Bridge.
    return (error as NodeJS.ErrnoException).code === "EPERM" ? null : false;
  }
}
export async function readLocalControlStatus(options: { home?: string; now?: number; requestId?: string } = {}) {
  if (process.platform === "win32") throw new Error("local_control_platform_unsupported");
  const home = options.home ?? homedir();
  const s = await loadSnapshot(home); const online = isOnline(s, options.now ?? Date.now());
  let request: unknown = null;
  if (options.requestId) {
    if (!id(options.requestId)) throw new Error("invalid_request_id");
    await assertControlDirectory(localControlPaths(home).results);
    try {
      const result = parseControlResult(await readControlJson(join(localControlPaths(home).results, `${options.requestId}.json`)));
      if (!result || result.id !== options.requestId) throw new Error("control_result_invalid");
      request = result;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { online, runningVersion: online ? s.runningVersion : null, lastKnownVersion: s.runningVersion, observedAt: s.updatedAt, runtime: s.runtime, mcp: s.mcp, update: s.update, request };
}
export async function submitLocalControl(action: ControlAction, options: { home?: string; now?: number } = {}) {
  if (process.platform === "win32") throw new Error("local_control_platform_unsupported");
  if (!CONTROL_ACTIONS.includes(action)) throw new Error("invalid_control_action");
  const home = options.home ?? homedir(), now = options.now ?? Date.now();
  let s: ControlSnapshot;
  try { s = await loadSnapshot(home); } catch { throw new Error("bridge_offline"); }
  const online = isOnline(s, now);
  if (online === false) throw new Error("bridge_offline");
  if (!s.binding) throw new Error("bridge_owner_not_bound");
  const paths = localControlPaths(home); await assertControlDirectory(paths.requests);
  const directory = await opendir(paths.requests);
  let entries = 0;
  for await (const _entry of directory) {
    if (++entries >= 64) throw new Error("control_queue_full");
  }
  const request: ControlRequest = { schemaVersion: 1, id: controlId(), action, instanceId: s.instanceId, binding: s.binding, createdAt: now };
  await writeControlJson(join(paths.requests, `${request.id}.json`), request);
  return { status: "submitted" as const, requestId: request.id, action, serviceLiveness: online === null ? "unverified" : "verified", nextAction: "finish_turn_then_check_status", message: "请求已写入本机队列，尚不表示 Bridge 已接收或升级完成。请先结束当前 Agent turn，再查询处理结果。" };
}
