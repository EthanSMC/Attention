import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ATTENTION_BRIDGE_PERMISSION_PROFILE as profile, type BridgeUpdateManifest } from "../bridge-update-contract";
import { parsePermissionProfile, permissionChanges, releaseIdentity, ownerFingerprint } from "./bridge-update-offer";
import { matchUpdateCommand } from "./bridge-update-control";
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const manifest: BridgeUpdateManifest = { artifact_path: "/cli/attention-0.3.18.mjs", minimum_supported_version: "0.3.5", node: ">=22.16.0", permission_profile_sha256: digest(profile), schema_version: 2, sha256: "a".repeat(64), version: "0.3.18" };
describe("WeChat update authority", () => {
    it("strictly validates the permission sidecar against its existing fingerprint", () => {
        expect(parsePermissionProfile(profile, digest(profile))).toEqual(profile);
        expect(() => parsePermissionProfile(profile, "b".repeat(64))).toThrow();
        expect(() => parsePermissionProfile({ ...profile, extra: true }, digest({ ...profile, extra: true }))).toThrow();
    });
    it("explains known cloud additions but refuses system and unknown permissions", () => {
        const old = { ...profile, cloud: { ...profile.cloud, tools: profile.cloud.tools.filter(x => x !== "attention_read_collection_source") } };
        expect(permissionChanges(old, profile)).toContain("新增：读取你已收藏的公开原文");
        expect(permissionChanges(profile, { ...profile, local: { ...profile.local, deny: [] } })).toBeNull();
        expect(permissionChanges(profile, { ...profile, cloud: { ...profile.cloud, tools: [...profile.cloud.tools, "unknown_tool"] } })).toBeNull();
    });
    it("binds approval to every manifest field, origin and running identity", () => {
        const base = releaseIdentity("https://attention.example", manifest, "0.3.17", digest(profile));
        for (const changed of [{ ...manifest, sha256: "b".repeat(64) }, { ...manifest, node: ">=24.0.0" }, { ...manifest, minimum_supported_version: "0.3.6" }]) {
            expect(releaseIdentity("https://attention.example", changed, "0.3.17", digest(profile))).not.toBe(base);
        }
        expect(releaseIdentity("https://other.example", manifest, "0.3.17", digest(profile))).not.toBe(base);
        expect(ownerFingerprint("owner")).toMatch(/^[a-f0-9]{64}$/);
    });
    it("only matches a complete top-level text command from an already pinned owner", () => {
        const message = { fromUserId: "owner", contextToken: "test", raw: {}, itemList: [{ type: 1, text_item: { text: "确认升级 0.3.18 K7M2Q9" } }] };
        expect(matchUpdateCommand(message, "owner")).toEqual({ kind: "confirm", version: "0.3.18", code: "K7M2Q9" });
        expect(matchUpdateCommand(message, null)).toBeNull();
        expect(matchUpdateCommand(message, "other")).toBeNull();
        for (const text of ["constructor", "toString", "__proto__", "好的", "同意", "不要升级", "为什么不能升级", "`确认升级 0.3.18 K7M2Q9`", "确认升级 0.3.18 K7M2Q9 https://example.com"]) {
            expect(matchUpdateCommand({ ...message, itemList: [{ type: 1, text_item: { text } }] }, "owner")).toBeNull();
        }
        expect(matchUpdateCommand({ ...message, itemList: [{ ...message.itemList[0], ref_msg: { title: "quoted" } }] }, "owner")).toBeNull();
        expect(matchUpdateCommand({ ...message, itemList: [{ type: 3, voice_item: { text: "确认升级 0.3.18 K7M2Q9" } }] }, "owner")).toBeNull();
    });
});
