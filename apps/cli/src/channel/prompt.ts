/**
 * Bridge prompt layer: the channel intent that turns a WeChat conversation
 * into a designated Attention collection channel.
 *
 * The intent is deliberately carried by the bridge, not by the public Skill:
 * the Skill keeps its interactive rule ("do not infer a save request merely
 * because a link appears"), while the bridge declares — for this designated
 * conversation only — that every incoming link or share text is an explicit
 * save request. See SKILL.md "Designated collection channels".
 */

import type { HistoryEntry } from "./state";

export const SKILL_REPORT_VERSION = "1.5.0";

const CHANNEL_INTENT = `你是 Attention 微信收藏助手，运行在用户本机的受限环境中。

## 工具边界
- 你只能使用 Attention MCP 的工具；禁止使用 shell、代码执行、文件写入、浏览器或任何非 Attention 工具。
- 如果所需工具不可用，直接用简短中文说明失败原因，不要尝试其他途径。

## 渠道约定（专用收藏会话）
- 本会话是用户声明的专用收藏渠道：用户发来的每一个链接或平台分享文案本身就是明确的收藏请求，直接调用 attention_collect_content，不要再要求确认。
- 用户也可能追问（例如“我刚才收藏了什么”“选 1”），请结合上下文连贯回答。

## 收藏调用规范
- client_context 固定为 { skill_id: "attention", skill_version: "${SKILL_REPORT_VERSION}", workflow_run_id: <本次消息的 message_ref> }。
- idempotency_key 使用 "bridge-" 加上本轮给出的 message_ref；重试必须复用同一个 key。
- 本会话第一次需要收藏时，先调用 attention_get_my_account 确认当前账号能力：有效 Filter 的新收藏 visibility 默认 public；Member 的新收藏默认 private。用户在本轮明确指定公开或私密时，以用户选择为准。
- 重复收藏永远保留原可见性，不要因为当前默认值调用 attention_update_collection 偷偷改变既有收藏。
- 结果处理：
  - accepted / already_collected / merged_with_existing_content：简短确认（可含标题），重复收藏要说明已在收藏中。
  - ambiguous：用编号列出候选，等待用户下一轮回复数字，然后调用 attention_select_collection_candidate；不要替用户猜。
  - resolution_pending：告知正在处理，稍后可再问结果。
  - invalid / unsafe：说明稳定原因并停止；不要改写链接绕过安全检查。

## 回复风格
- 简体中文，简短直接，不超过 200 字，先结论后细节。
- 不要解释你的内部流程，不要输出 token、密钥或内部字段。
- 与收藏无关的闲聊，礼貌地简短回应即可。`;

function formatHistory(history: readonly HistoryEntry[]): string {
  if (history.length === 0) return "（暂无历史对话）";
  return history
    .map((entry) => `${entry.role === "user" ? "用户" : "助手"}: ${entry.content}`)
    .join("\n");
}

/**
 * First turn of a fresh host session: full channel intent plus the user's
 * message and the bridge-provided message reference.
 */
export function buildFirstTurnPrompt(input: {
  readonly messageRef: string;
  readonly userMessage: string;
}): string {
  return `${CHANNEL_INTENT}

## 本轮消息
message_ref: ${input.messageRef}

用户消息：
${input.userMessage}`;
}

/**
 * Follow-up turn continuing an existing host session: the session already
 * carries the intent and prior turns, so only the new message is sent.
 */
export function buildFollowUpPrompt(input: {
  readonly messageRef: string;
  readonly userMessage: string;
}): string {
  return `message_ref: ${input.messageRef}

用户消息：
${input.userMessage}`;
}

/**
 * Replay fallback when the host session cannot be resumed: the intent and a
 * bounded transcript are re-sent together with the current message.
 */
export function buildReplayPrompt(input: {
  readonly history: readonly HistoryEntry[];
  readonly messageRef: string;
  readonly userMessage: string;
}): string {
  return `${CHANNEL_INTENT}

## 对话历史
${formatHistory(input.history)}

## 本轮消息
message_ref: ${input.messageRef}

用户消息：
${input.userMessage}`;
}
