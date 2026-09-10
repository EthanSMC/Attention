import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { localControlPaths, prepareLocalControl, readLocalControlStatus, submitLocalControl, writeControlJson, parseControlRequest, readControlJson } from "./local-control";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { force: true, recursive: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "attention-control-")); dirs.push(home); await prepareLocalControl(home);
  const status = { schemaVersion: 1 as const, instanceId: "a".repeat(32), binding: "b".repeat(64), pid: process.pid, updatedAt: Date.now(), runningVersion: "0.3.18", runtime: "healthy", mcp: "ready", update: { candidateVersion: null, phase: "idle", latestVerified: null, lastErrorCode: null } };
  await writeControlJson(localControlPaths(home).status, { ...status, service: "running" });
  return { home, status };
}
it("submits local control without OAuth or network, and reports submitted rather than upgraded", async () => {
  const f = await fixture(); const result = await submitLocalControl("request", { home: f.home });
  expect(result.status).toBe("submitted"); expect(result.requestId).toMatch(/^[a-f0-9]{32}$/);
  expect((await readLocalControlStatus({ home: f.home })).runningVersion).toBe("0.3.18");
});
it("fails closed for offline or stale runtime, arbitrary commands and parameters", async () => {
  const f = await fixture(); await writeControlJson(localControlPaths(f.home).status, { ...f.status, updatedAt: 1 });
  await expect(submitLocalControl("request", { home: f.home })).rejects.toThrow("bridge_offline");
  expect(parseControlRequest({ schemaVersion: 1, action: "confirm", id: "a".repeat(32), instanceId: "a".repeat(32), binding: "b".repeat(64), createdAt: Date.now() })).toBeNull();
  expect(parseControlRequest({ command: "rm -rf /", action: "request" })).toBeNull();
});
it("does not follow a symlink in the control directory or status file", async () => {
  const f = await fixture(); const target = join(f.home, "outside"); await writeFile(target, "private");
  await rm(localControlPaths(f.home).status); await symlink(target, localControlPaths(f.home).status);
  await expect(readLocalControlStatus({ home: f.home })).rejects.toThrow();
  await rm(localControlPaths(f.home).requests, { recursive: true }); await symlink(f.home, localControlPaths(f.home).requests);
  await expect(prepareLocalControl(f.home)).rejects.toThrow("control_path_unsafe");
});
it.skipIf(process.platform === "win32")("rejects a FIFO without blocking the service loop", async () => {
  const f = await fixture(); const fifo = join(localControlPaths(f.home).requests, "fifo");
  await promisify(execFile)("mkfifo", [fifo]);
  await expect(readControlJson(fifo)).rejects.toThrow("control_file_unsafe");
});
