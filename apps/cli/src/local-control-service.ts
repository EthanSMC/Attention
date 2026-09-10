import { opendir, unlink } from "node:fs/promises";
import type { Dir } from "node:fs";
import { join, resolve } from "node:path";
import type { ChannelState } from "./channel/state";
import { ownerFingerprint } from "./channel/bridge-update-offer";
import type { BridgeUpdateController } from "./channel/bridge-update-controller";
import { assertControlDirectory, CONTROL_TTL_MS, controlId, localControlPaths, parseControlRequest, parseControlResult, prepareLocalControl, readControlJson, writeControlJson, type ControlResult, type ControlSnapshot } from "./local-control";

const RESULT_RETENTION_MS = 24 * 60 * 60_000;
/** A fixed, bounded local adapter. Only the existing update controller mutates its journal. */
export class LocalControlService {
  private readonly instanceId = controlId();
  private prepared = false;
  private snapshot: ControlSnapshot | null = null;
  private cursors: Partial<Record<"requests" | "results", Dir>> = {};
  constructor(private readonly options: { home: string; controller: Pick<BridgeUpdateController, "dispatch" | "snapshot">; now?: () => number }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private async nextEntry(kind: "requests" | "results") {
    const cursor = this.cursors[kind] ??= await opendir(localControlPaths(this.options.home)[kind]);
    const entry = await cursor.read();
    if (!entry) { await cursor.close(); delete this.cursors[kind]; }
    return entry;
  }
  async tick(state: ChannelState): Promise<void> {
    const { home, controller } = this.options, paths = localControlPaths(home);
    if (!this.prepared) { await prepareLocalControl(home); this.prepared = true; }
    // Revalidate every parent before reading Agent-owned input; never accept caller-supplied paths.
    for (const path of [join(resolve(home), ".attention"), paths.root, paths.requests, paths.results]) await assertControlDirectory(path);
    const binding = state.ownerUserId ? ownerFingerprint(state.ownerUserId) : null;
    for (let scanned = 0; scanned < 64; scanned++) {
      const entry = await this.nextEntry("requests");
      if (!entry) break;
      if (!/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
      if (entry.isDirectory()) continue;
      const id = entry.name.slice(0, -5), file = join(paths.requests, entry.name), resultPath = join(paths.results, entry.name);
      // A receipt is durable across service restarts. Journal dedup covers dispatch-before-receipt crashes.
      let existing: ControlResult | null = null;
      try { existing = parseControlResult(await readControlJson(resultPath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing?.id === id) { await unlink(file); continue; }
      let request = null;
      try { request = parseControlRequest(await readControlJson(file)); } catch { /* Untrusted input is rejected, never executed. */ }
      let code: string | null = null;
      if (!request || request.id !== id) code = "invalid_control_request";
      else if (request.instanceId !== this.instanceId) code = "service_instance_changed";
      else if (!binding || request.binding !== binding) code = "owner_binding_changed";
      else if (request.createdAt > this.now() || this.now() - request.createdAt >= CONTROL_TTL_MS) code = "request_expired";
      const outcome = code ? { status: "rejected" as const, code } : await controller.dispatch({ kind: request!.action === "request" ? "upgrade" : request!.action }, `cli:${id}`, state);
      const result: ControlResult = { schemaVersion: 1, id, instanceId: this.instanceId, action: request?.action ?? null, ...outcome, processedAt: this.now() };
      await writeControlJson(resultPath, result);
      await unlink(file);
    }
    const update = controller.snapshot();
    this.snapshot = { schemaVersion: 1, instanceId: this.instanceId, binding, pid: process.pid, updatedAt: this.now(), runningVersion: update.runningVersion, service: "running", runtime: state.runtimeState.phase, mcp: state.attentionMcp.status, update: { candidateVersion: update.candidateVersion, phase: update.phase, latestVerified: update.latestVerified, lastErrorCode: update.lastErrorCode } };
    await writeControlJson(paths.status, this.snapshot);
    for (let scanned = 0; scanned < 64; scanned++) {
      const entry = await this.nextEntry("results");
      if (!entry) break;
      if (!/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
      const file = join(paths.results, entry.name);
      const receipt = parseControlResult(await readControlJson(file));
      if (receipt && this.now() - receipt.processedAt > RESULT_RETENTION_MS) await unlink(file);
    }
  }
  async stop(): Promise<void> {
    for (const cursor of Object.values(this.cursors)) await cursor?.close();
    this.cursors = {};
    if (this.snapshot) await writeControlJson(localControlPaths(this.options.home).status, { ...this.snapshot, service: "stopped", updatedAt: this.now() });
  }
}
