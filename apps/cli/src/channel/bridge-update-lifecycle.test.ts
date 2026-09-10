import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ATTENTION_BRIDGE_PERMISSION_PROFILE as profile, type BridgeUpdateManifest } from "../bridge-update-contract";
import { BridgeUpdateController } from "./bridge-update-controller";
import { loadUpdateJournal } from "./bridge-update-journal";
import { updateDigest } from "./bridge-update-offer";
import { bootstrapManagedBridge, loadManagedBridgeUpdateState, managedBridgePaths } from "./managed-bridge";
import { enqueueInbound, markOutboundSent } from "./queue";
import { defaultChannelState, loadChannelState, saveChannelState } from "./state";
const run = promisify(execFile), homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it.each([false, true])("persists consent, drains receipts, launches a real child and reconciles rollback=%s", async (rollback) => {
    const home = await mkdtemp(join(tmpdir(), "attention-wechat-lifecycle-"));
    homes.push(home);
    const paths = managedBridgePaths(home);
    const old = { ...profile, cloud: { ...profile.cloud, tools: profile.cloud.tools.filter(t => t !== "attention_read_collection_source") } };
    const baseline = join(home, "baseline.mjs");
    await writeFile(baseline, 'console.log("baseline-started")');
    await bootstrapManagedBridge({ homeDirectory: home, currentArtifactPath: baseline, version: "0.3.17", permissionProfileSha256: updateDigest(old) });
    const candidate = Buffer.from(`import fs from "node:fs";
if(process.argv.includes("--bridge-update-probe")) console.log(JSON.stringify({permission_profile_sha256:${JSON.stringify(updateDigest(profile))},version:"0.3.18"}));
else if(process.argv.includes("--bridge-update-protocol")) console.log(JSON.stringify({channel_state_schema:1,update_journal_schema:1,wechat_update_protocol:1}));
else if(${rollback}) process.exit(1);
else { const path=process.env.ATTENTION_BRIDGE_UPDATE_STATE_PATH; const state=JSON.parse(fs.readFileSync(path,"utf8")); state.pending=null;state.previous=null;state.status="current";fs.writeFileSync(path,JSON.stringify(state)); console.log("candidate-healthy"); }
`);
    const manifest: BridgeUpdateManifest = { artifact_path: "/cli/attention-0.3.18.mjs", minimum_supported_version: "0.3.5", node: ">=22.16.0", permission_profile_sha256: updateDigest(profile), schema_version: 2, sha256: createHash("sha256").update(candidate).digest("hex"), version: "0.3.18" };
    const options = { homeDirectory: home, currentVersion: "0.3.17", currentPermissionProfileSha256: updateDigest(old), currentProfile: old, origin: "https://attention.example", fetchImpl: async (input: string | URL | Request) => {
            const url = String(input), json = !url.endsWith(".mjs");
            const response = new Response(json ? JSON.stringify(url.endsWith("manifest.json") ? manifest : profile) : candidate.toString(), { headers: { "content-type": json ? "application/json" : "text/javascript" } });
            Object.defineProperty(response, "url", { value: url });
            return response;
        } };
    const controller = new BridgeUpdateController(options), state = defaultChannelState();
    state.token = "fake-ilink-test-token";
    state.ownerUserId = "test-owner";
    state.contextTokens["test-owner"] = "fake-context";
    state.history = [{ role: "user", content: "test business history" }];
    state.syncBuf = "test-cursor";
    const persist = async () => saveChannelState(state, home);
    const send = (text: string, id: string) => enqueueInbound(state, [{ fromUserId: "test-owner", contextToken: "fake-context", raw: { message_id: id }, itemList: [{ type: 1, text_item: { text } }] }]);
    const waitFor = async (phase: string) => { for (let i = 0; i < 200; i++) {
        await controller.tick(state, persist);
        if ((await loadUpdateJournal(home)).operation?.phase === phase)
            return;
        await new Promise(r => setTimeout(r, 5));
    } throw new Error(`missing phase ${phase}`); };
    await waitFor("offered");
    const command = state.pendingOutbound[0]!.text.match(/确认升级 0\.3\.18 [A-Z0-9]{6}/u)![0];
    // Seven durable business messages blocked by OAuth must not block the eighth control message.
    for (let i = 0; i < 7; i++)
        send(`queued business ${i}`, `business-${i}`);
    state.pendingInbound.forEach(p => p.blockedBy = "attention_mcp");
    send(command, "approve");
    await persist();
    await waitFor("waiting_safe_point");
    expect(state.pendingInbound).toHaveLength(7);
    expect(await controller.activateIfSafe(state, persist)).toBe(false);
    // Fake iLink's acknowledged sends use the actual durable outbox transition.
    const sentIds: string[] = [];
    for (const message of [...state.pendingOutbound]) {
        sentIds.push(message.id);
        markOutboundSent(state, message.id);
        await persist();
    }
    await controller.tick(state, persist);
    expect(await controller.activateIfSafe(state, persist, () => false)).toBe(false);
    expect(await controller.activateIfSafe(state, persist)).toBe(true);
    expect((await loadUpdateJournal(home)).operation?.phase).toBe("switching");
    expect((await loadManagedBridgeUpdateState(home)).current.version).toBe("0.3.18");
    const launched = await run(process.execPath, [paths.launcherPath], { timeout: 5000, env: { PATH: process.env.PATH, ATTENTION_BRIDGE_UPDATE_STATE_PATH: paths.statePath, ATTENTION_BRIDGE_STARTUP_TIMEOUT_MS: "500" } });
    expect(launched.stdout).toContain(rollback ? "baseline-started" : "candidate-healthy");
    const restored = await loadChannelState(home), managed = await loadManagedBridgeUpdateState(home);
    expect(restored.token).toBe("fake-ilink-test-token");
    expect(restored.syncBuf).toBe("test-cursor");
    expect(restored.pendingInbound).toHaveLength(7);
    expect(restored.history).toEqual(state.history);
    const restarted = new BridgeUpdateController({ ...options, currentVersion: managed.current.version, currentPermissionProfileSha256: managed.current.permissionProfileSha256, currentProfile: rollback ? old : profile });
    await restarted.tick(restored, async () => saveChannelState(restored, home));
    expect((await loadUpdateJournal(home)).operation?.phase).toBe(rollback ? "rolled_back" : "started");
    expect(restored.pendingOutbound.at(-1)!.text).toContain(rollback ? "已回滚" : "授权/连接仍需恢复");
    if (!rollback) expect(restored.pendingOutbound.at(-1)!.text).toContain("这不代表收藏摘要已补全。");
    expect(sentIds).not.toContain(restored.pendingOutbound.at(-1)!.id);
    expect(await readFile(join(home, ".attention/update/wechat-update.json"), "utf8")).not.toContain("fake-ilink-test-token");
    await restarted.stop();
    await controller.stop();
});
