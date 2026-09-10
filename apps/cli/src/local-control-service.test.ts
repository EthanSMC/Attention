import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultChannelState } from "./channel/state";
import { LocalControlService } from "./local-control-service";
import { CONTROL_TTL_MS, localControlPaths, readControlJson, readLocalControlStatus, submitLocalControl, writeControlJson } from "./local-control";
import { runAttentionCli } from "./main";
const homes: string[] = [];
const services: LocalControlService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "attention-local-loop-")); homes.push(home);
  let offset = 0;
  const state = defaultChannelState(); state.ownerUserId = "owner"; state.runtimeState.phase = "stopped";
  const controller = { dispatch: vi.fn(async () => ({ status: "accepted" as const, code: "checking" })), snapshot: () => ({ runningVersion: "0.3.18", phase: "idle", candidateVersion: null, latestVerified: null, lastErrorCode: null }) };
  const service = new LocalControlService({ home, controller, now: () => Date.now() + offset });
  services.push(service);
  await service.tick(state);
  return { home, state, controller, service, advance: (ms: number) => { offset += ms; }, now: () => Date.now() + offset };
}
it("runs CLI -> inbox -> controller -> receipt even while Codex is stopped and MCP is not ready", async () => {
  const f = await fixture(), output = { log: vi.fn(), error: vi.fn() }, networkCheck = vi.fn();
  expect(await runAttentionCli(["channel", "update", "request", "--json"], { localControlHome: f.home, output, checkCliUpdate: networkCheck })).toBe(0);
  expect(networkCheck).not.toHaveBeenCalled();
  const queued = JSON.parse(output.log.mock.calls[0]![0]); expect(queued.status).toBe("submitted");
  expect(f.controller.dispatch).not.toHaveBeenCalled();
  await f.service.tick(f.state);
  expect(f.controller.dispatch).toHaveBeenCalledWith({ kind: "upgrade" }, `cli:${queued.requestId}`, f.state);
  expect(await readLocalControlStatus({ home: f.home, requestId: queued.requestId })).toMatchObject({ online: true, runtime: "stopped", request: { status: "accepted", code: "checking" } });
  await f.service.stop();
  await expect(submitLocalControl("check", { home: f.home })).rejects.toThrow("bridge_offline");
});
it("rejects expired, changed-owner, changed-process and forged approval requests", async () => {
  const f = await fixture(), paths = localControlPaths(f.home);
  for (const [change, code] of [
    [{ createdAt: f.now() - CONTROL_TTL_MS }, "request_expired"],
    [{ binding: "0".repeat(64) }, "owner_binding_changed"],
    [{ instanceId: "0".repeat(32) }, "service_instance_changed"],
    [{ action: "confirm" }, "invalid_control_request"],
    [{ command: "shell command" }, "invalid_control_request"],
  ] as const) {
    const q = await submitLocalControl("request", { home: f.home });
    const file = join(paths.requests, `${q.requestId}.json`);
    await writeControlJson(file, { ...await readControlJson(file) as object, ...change });
    await f.service.tick(f.state);
    expect((await readLocalControlStatus({ home: f.home, requestId: q.requestId })).request).toMatchObject({ status: "rejected", code });
  }
  expect(f.controller.dispatch).not.toHaveBeenCalled();
});
it("never follows request symlinks and does not repeat a receipted operation", async () => {
  const f = await fixture(), paths = localControlPaths(f.home);
  const q = await submitLocalControl("check", { home: f.home });
  const file = join(paths.requests, `${q.requestId}.json`), raw = await readControlJson(file);
  await f.service.tick(f.state);
  await writeControlJson(file, raw); await f.service.tick(f.state);
  expect(f.controller.dispatch).toHaveBeenCalledTimes(1);
  const linkId = "f".repeat(32); await symlink(paths.status, join(paths.requests, `${linkId}.json`));
  await f.service.tick(f.state);
  expect((await readLocalControlStatus({ home: f.home, requestId: linkId })).request).toMatchObject({ code: "invalid_control_request" });
  expect(await readControlJson(paths.status)).toBeTruthy();
  expect(f.controller.dispatch).toHaveBeenCalledTimes(1);
});
it("returns bounded JSON errors and does not check network on local status or invalid local requests", async () => {
  const f = await fixture(), output = { log: vi.fn(), error: vi.fn() }, checkCliUpdate = vi.fn();
  for (const args of [["channel", "update", "confirm", "--json"], ["channel", "update", "request", "--origin", "https://bad.example", "--json"]]) {
    expect(await runAttentionCli(args, { output, checkCliUpdate, localControlHome: f.home })).toBe(2);
    expect(JSON.parse(output.log.mock.calls.at(-1)![0])).toMatchObject({ status: "error", code: "invalid_control_arguments" });
  }
  const runChannel = vi.fn(async () => 0);
  await runAttentionCli(["channel", "status", "--json"], { output, checkCliUpdate, runChannel });
  expect(checkCliUpdate).not.toHaveBeenCalled();
});
it("caps client queue size and advances its bounded scan past invalid entries", async () => {
  const f = await fixture(), paths = localControlPaths(f.home);
  const q = await submitLocalControl("check", { home: f.home });
  const requestFile = join(paths.requests, `${q.requestId}.json`), raw = await readControlJson(requestFile);
  await rm(requestFile);
  for (let i = 0; i < 70; i++) await writeControlJson(join(paths.requests, `ignored-${i}`), {});
  await expect(submitLocalControl("check", { home: f.home })).rejects.toThrow("control_queue_full");
  await writeControlJson(requestFile, raw);
  await f.service.tick(f.state); await f.service.tick(f.state);
  expect(f.controller.dispatch).toHaveBeenCalledTimes(1);
});
