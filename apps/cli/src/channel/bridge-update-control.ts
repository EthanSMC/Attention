import type { InboundMessage } from "./messages";
export type UpdateCommand = {
    kind: "check" | "status" | "defer" | "cancel" | "confirm_help";
} | {
    kind: "confirm";
    version: string;
    code: string;
};
/** No quotes, voice transcripts, model text or first-message owner binding grant authority. */
export function matchUpdateCommand(message: InboundMessage, owner: string | null): UpdateCommand | null {
    if (!owner || message.fromUserId !== owner || !Array.isArray(message.itemList) || message.itemList.length !== 1)
        return null;
    const item = message.itemList[0];
    if (!item || typeof item !== "object" || item.type !== 1 || "ref_msg" in item ||
        !item.text_item || typeof item.text_item.text !== "string")
        return null;
    const text = item.text_item.text.normalize("NFKC").trim();
    const commands: Record<string, UpdateCommand["kind"]> = { "检查更新": "check", "升级状态": "status", "稍后升级": "defer", "取消升级": "cancel", "确认升级": "confirm_help" };
    const kind = Object.hasOwn(commands, text) ? commands[text] : undefined;
    if (kind && kind !== "confirm")
        return { kind };
    const match = /^确认升级 (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) ([A-Z0-9]{6})$/u.exec(text);
    return match ? { kind: "confirm", version: `${match[1]}.${match[2]}.${match[3]}`, code: match[4]! } : null;
}
