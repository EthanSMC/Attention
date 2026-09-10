import { createHash } from "node:crypto";
import { normalizeAttentionOrigin } from "../origin";
import type { BridgeUpdateManifest } from "../bridge-update-contract";
export interface PermissionProfile {
    cloud: {
        mcp_server: string;
        runtime_oauth: {
            resource: string;
            scopes: readonly string[];
        };
        tools: readonly string[];
    };
    local: {
        deny: readonly string[];
        write: readonly string[];
    };
    native_network: readonly string[];
    schema_version: number;
}
const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
    attention_get_my_account: "查看你的 Attention 账号与权益",
    attention_list_collections: "查询你的收藏",
    attention_collect_content: "保存你发送的收藏",
    attention_submit_content_enrichment: "为你的收藏补全共享摘要",
    attention_select_collection_candidate: "确认你选择的收藏链接",
    attention_get_collection_status: "查询你的收藏处理状态",
    attention_read_collection_source: "读取你已收藏的公开原文",
    attention_update_collection: "调整你的收藏公开或私密状态",
};
export function updateDigest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
        throw new Error("permission_profile_invalid");
    return value as Record<string, unknown>;
}
function words(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 32 || value.some(x => typeof x !== "string" || !/^[a-z][a-z0-9_:-]{0,95}$/u.test(x)) || new Set(value).size !== value.length)
        throw new Error("permission_profile_invalid");
    return value as string[];
}
function word(value: unknown): string { return words([value])[0]!; }
/** Rebuilds the original constant's key order; never hashes arbitrary JSON key order. */
export function parsePermissionProfile(value: unknown, expectedSha: string): PermissionProfile {
    const root = object(value, ["cloud", "local", "native_network", "schema_version"]);
    const cloud = object(root.cloud, ["mcp_server", "runtime_oauth", "tools"]);
    const oauth = object(cloud.runtime_oauth, ["resource", "scopes"]);
    const local = object(root.local, ["deny", "write"]);
    if (root.schema_version !== 2)
        throw new Error("permission_profile_invalid");
    const profile: PermissionProfile = {
        cloud: { mcp_server: word(cloud.mcp_server), runtime_oauth: { resource: word(oauth.resource), scopes: words(oauth.scopes) }, tools: words(cloud.tools) },
        local: { deny: words(local.deny), write: words(local.write) }, native_network: words(root.native_network), schema_version: 2,
    };
    if (updateDigest(profile) !== expectedSha)
        throw new Error("permission_profile_digest_mismatch");
    return profile;
}
export function permissionChanges(current: PermissionProfile, next: PermissionProfile): string[] | null {
    if (updateDigest({ ...current, cloud: { ...current.cloud, tools: [] } }) !== updateDigest({ ...next, cloud: { ...next.cloud, tools: [] } }) ||
        next.cloud.tools.some(x => !Object.hasOwn(TOOL_DESCRIPTIONS, x)) || current.cloud.tools.some(x => !Object.hasOwn(TOOL_DESCRIPTIONS, x)))
        return null;
    return [
        ...next.cloud.tools.filter(x => !current.cloud.tools.includes(x)).map(x => `新增：${TOOL_DESCRIPTIONS[x]}`),
        ...current.cloud.tools.filter(x => !next.cloud.tools.includes(x)).map(x => `移除：${TOOL_DESCRIPTIONS[x]}`),
    ];
}
export function releaseIdentity(origin: string, manifest: BridgeUpdateManifest, currentVersion: string, currentPermissionSha: string): string {
    return updateDigest({ origin: normalizeAttentionOrigin(origin), currentVersion, currentPermissionSha,
        manifest: { artifact_path: manifest.artifact_path, minimum_supported_version: manifest.minimum_supported_version, node: manifest.node,
            permission_profile_sha256: manifest.permission_profile_sha256, schema_version: manifest.schema_version, sha256: manifest.sha256, version: manifest.version } });
}
export function ownerFingerprint(owner: string): string { return updateDigest(["bridge-update-owner", owner]); }
