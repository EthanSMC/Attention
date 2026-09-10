import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ATTENTION_BRIDGE_PERMISSION_PROFILE as profile, type BridgeUpdateManifest } from "../bridge-update-contract";
import { BridgeUpdateController } from "./bridge-update-controller";
import { updateDigest } from "./bridge-update-offer";
import { loadUpdateJournal } from "./bridge-update-journal";
import { bootstrapManagedBridge, loadManagedBridgeUpdateState } from "./managed-bridge";
import { defaultChannelState } from "./state";
import { enqueueInbound } from "./queue";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), "wechat-update-"));
    homes.push(home);
    const old = { ...profile, cloud: { ...profile.cloud, tools: profile.cloud.tools.filter(t => t !== "attention_read_collection_source") } };
    const current = join(home, "baseline.mjs");
    await writeFile(current, "// baseline");
    await bootstrapManagedBridge({ homeDirectory: home, currentArtifactPath: current, version: "0.3.17", permissionProfileSha256: updateDigest(old) });
    const manifest: BridgeUpdateManifest = { artifact_path: "/cli/attention-0.3.18.mjs", minimum_supported_version: "0.3.5", node: ">=22.16.0", permission_profile_sha256: updateDigest(profile), schema_version: 2, sha256: "a".repeat(64), version: "0.3.18" };
    let requests = 0, now = 100000;
    const options = { homeDirectory: home, currentVersion: "0.3.17", currentPermissionProfileSha256: updateDigest(old), currentProfile: old, origin: "https://attention.example", now: () => new Date(now), fetchImpl: async (input: string | URL | Request) => {
            requests++;
            const url = String(input);
            const response = new Response(JSON.stringify(url.endsWith("manifest.json") ? manifest : profile), { headers: { "content-type": "application/json" } });
            Object.defineProperty(response, "url", { value: url });
            return response;
        } };
    const state = defaultChannelState();
    state.ownerUserId = "owner";
    state.contextTokens.owner = "test-context";
    const controller = new BridgeUpdateController(options);
    const persist = async () => { };
    const send = (text: string, id = text) => enqueueInbound(state, [{ fromUserId: "owner", contextToken: "test-context", raw: { message_id: id }, itemList: [{ type: 1, text_item: { text } }] }]);
    const settle = async () => { for (let i = 0; i < 8; i++) {
        await controller.tick(state, persist);
        await new Promise(r => setTimeout(r, 2));
    } };
    return { home, options, state, controller, persist, send, settle, manifest, requests: () => requests, advance: (ms: number) => { now += ms; } };
}
it("notifies once, processes control beyond five OAuth-blocked messages and status is local-only", async () => {
    const f = await fixture();
    await f.settle();
    expect(f.state.pendingOutbound).toHaveLength(1);
    expect(f.state.pendingOutbound[0]!.text).toContain("确认升级 0.3.18");
    const requests = f.requests();
    for (let i = 0; i < 7; i++)
        f.send(`business ${i}`);
    for (const pending of f.state.pendingInbound)
        pending.blockedBy = "attention_mcp";
    f.send("升级状态");
    await f.controller.tick(f.state, f.persist);
    expect(f.state.pendingInbound).toHaveLength(7);
    expect(f.requests()).toBe(requests);
    expect(f.state.pendingOutbound.at(-1)!.text).toContain("运行 Bridge：0.3.17");
    await f.settle();
    expect(f.state.pendingOutbound).toHaveLength(2);
});
it("expires offers, limits bad confirmation attempts, and consumes duplicate commands only once", async () => {
    const f = await fixture();
    await f.settle();
    for (let i = 0; i < 3; i++) {
        f.send("确认升级 0.3.18 000000", String(i));
        await f.controller.tick(f.state, f.persist);
    }
    expect((await loadUpdateJournal(f.home)).operation?.phase).toBe("expired");
    f.advance(61000);
    f.send("检查更新", "check2");
    await f.settle();
    const text = f.state.pendingOutbound.findLast(p => p.text.includes("确认升级 0.3.18"))!.text;
    const command = text.match(/确认升级 0\.3\.18 [A-Z0-9]{6}/u)![0];
    f.advance(600001);
    f.send(command, "late");
    await f.controller.tick(f.state, f.persist);
    expect((await loadUpdateJournal(f.home)).operation?.phase).toBe("expired");
    expect((await loadManagedBridgeUpdateState(f.home)).current.version).toBe("0.3.17");
});
it("persists one-use approval before download, allows cancellation without touching the selected artifact", async () => {
    const f = await fixture();
    await f.settle();
    const command = f.state.pendingOutbound[0]!.text.match(/确认升级 0\.3\.18 [A-Z0-9]{6}/u)![0];
    f.send(command, "approve");
    await f.controller.tick(f.state, f.persist);
    expect(["approved", "downloading"]).toContain((await loadUpdateJournal(f.home)).operation?.phase);
    f.send("取消升级");
    await f.controller.tick(f.state, f.persist);
    expect((await loadUpdateJournal(f.home)).operation?.phase).toBe("cancelled");
    expect((await loadManagedBridgeUpdateState(f.home)).current.version).toBe("0.3.17");
    expect(f.state.history).toHaveLength(0);
});
it("reconciles queued receipts after restart without sending duplicate IDs", async () => {
    const f = await fixture();
    await f.settle();
    const id = f.state.pendingOutbound[0]!.id;
    const restarted = new BridgeUpdateController(f.options);
    await restarted.tick(f.state, f.persist);
    expect(f.state.pendingOutbound.map(p => p.id)).toEqual([id]);
    f.state.pendingOutbound = [];
    await restarted.tick(f.state, f.persist);
    expect((await loadUpdateJournal(f.home)).events[0]!.delivery).toBe("delivered");
    expect(f.state.pendingOutbound).toHaveLength(0);
});
