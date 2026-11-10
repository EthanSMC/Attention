import { SessionManager, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { WebsiteAgentError } from "./errors.js";

/** A storage envelope around Pi's unchanged native v3 entries and selected leaf. */
export interface NativeWebsiteAgentSession { entries: FileEntry[]; leafId: string | null }
export const WEBSITE_AGENT_NATIVE_SESSION_MAX_BYTES = 512 * 1024;
export const WEBSITE_AGENT_VIRTUAL_CWD = "/attention/website-agent";
export const REDACTED_TOOL_RESULT = "[Tool result omitted from durable session; request fresh authorized data when needed.]";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const invalid = (): never => { throw new WebsiteAgentError("invalid_session"); };
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const tokenCount = (value: unknown) => nonnegative(value) && Number.isSafeInteger(value);
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const safeToolName = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value);

/** Native usage is numeric accounting metadata, never an arbitrary persistence channel. */
function validUsage(value: unknown): boolean {
  if (!object(value) || !keys(value, ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"])
    || ![value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens].every(tokenCount)
    || (value.cacheWrite1h !== undefined && !tokenCount(value.cacheWrite1h)) || (value.reasoning !== undefined && !tokenCount(value.reasoning))
    || !object(value.cost) || !keys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])) return false;
  return [value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite, value.cost.total].every(nonnegative);
}

/** Validate native structure and security constraints; ownership is always checked by the host first. */
export function parseNativeWebsiteSession(value: unknown, expectedSessionId: string): NativeWebsiteAgentSession {
  if (!uuid.test(expectedSessionId) || !object(value) || !keys(value, ["entries", "leafId"]) || !Array.isArray(value.entries)
    || value.entries.length === 0 || value.entries.length > 4096 || !(value.leafId === null || typeof value.leafId === "string")) return invalid();
  let snapshot: NativeWebsiteAgentSession;
  try {
    if (byteSize(value) > WEBSITE_AGENT_NATIVE_SESSION_MAX_BYTES) throw new WebsiteAgentError("session_full");
    snapshot = JSON.parse(JSON.stringify(value)) as NativeWebsiteAgentSession;
  } catch (error) { if (error instanceof WebsiteAgentError) throw error; return invalid(); }
  const header = snapshot.entries[0];
  if (!header || header.type !== "session" || header.id !== expectedSessionId || header.version !== 3
    || header.cwd !== WEBSITE_AGENT_VIRTUAL_CWD || typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))
    || !keys(header as unknown as Record<string, unknown>, ["type", "id", "version", "timestamp", "cwd"])) return invalid();
  const ids = new Set<string>();
  const parents = new Map<string, string | null>();
  for (const raw of snapshot.entries.slice(1)) {
    const entry = raw as SessionEntry;
    if (!object(entry) || !safeId(entry.id) || entry.id === header.id || ids.has(entry.id)
      || !(entry.parentId === null || (typeof entry.parentId === "string" && ids.has(entry.parentId)))
      || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) return invalid();
    if (entry.type === "message") {
      if (!keys(entry as unknown as Record<string, unknown>, ["type", "id", "parentId", "timestamp", "message"])) return invalid();
      const message = entry.message;
      if (!object(message) || !tokenCount(message.timestamp) || !Array.isArray(message.content)) return invalid();
      if (message.role === "user") {
        if (!keys(message, ["role", "content", "timestamp"]) || message.content.some(part => !object(part) || !keys(part, ["type", "text"]) || part.type !== "text" || typeof part.text !== "string")) return invalid();
      } else if (message.role === "assistant") {
        if (!keys(message, ["role", "content", "timestamp", "api", "provider", "model", "usage", "stopReason", "errorMessage"])
          || message.api !== "openai-completions" || message.provider !== "deepseek" || message.model !== "deepseek-flash"
          || !["stop", "toolUse", "error", "aborted", "length"].includes(message.stopReason)
          || !validUsage(message.usage) || (message.errorMessage !== undefined && message.errorMessage !== "The model request did not complete.")
          || message.content.some(part => !object(part) || (part.type === "text" ? typeof part.text !== "string" || !keys(part, ["type", "text"]) || message.stopReason !== "stop" : part.type === "toolCall" ? !safeId(part.id) || !safeToolName(part.name) || !isDeepStrictEqual(part.arguments, {}) || !keys(part, ["type", "id", "name", "arguments"]) : true))) return invalid();
        if (message.content.some(part => part.type === "toolCall") && message.content.some(part => part.type === "text")) return invalid();
      } else if (message.role === "toolResult") {
        if (!keys(message, ["role", "content", "timestamp", "toolCallId", "toolName", "isError", "details"])
          || !safeId(message.toolCallId) || !safeToolName(message.toolName) || typeof message.isError !== "boolean"
          || !isDeepStrictEqual(message.content, [{ type: "text", text: REDACTED_TOOL_RESULT }])
          || !isDeepStrictEqual(message.details, {})) return invalid();
      } else return invalid();
    } else if (entry.type === "compaction") {
      if (!keys(entry as unknown as Record<string, unknown>, ["type", "id", "parentId", "timestamp", "summary", "firstKeptEntryId", "tokensBefore", "details", "usage", "fromHook"])
        || typeof entry.summary !== "string" || !entry.summary.trim() || !ids.has(entry.firstKeptEntryId)
        || !tokenCount(entry.tokensBefore) || (entry.usage !== undefined && !validUsage(entry.usage))
        || (entry.fromHook !== undefined && entry.fromHook !== false)
        || (entry.details !== undefined && !isDeepStrictEqual(entry.details, { readFiles: [], modifiedFiles: [] }))) return invalid();
      let ancestor = entry.parentId;
      while (ancestor !== null && ancestor !== entry.firstKeptEntryId) ancestor = parents.get(ancestor) ?? null;
      if (ancestor === null) return invalid();
    } else return invalid();
    ids.add(entry.id);
    parents.set(entry.id, entry.parentId);
  }
  if (snapshot.leafId !== null && !ids.has(snapshot.leafId)) return invalid();
  return snapshot;
}

export function createNativeWebsiteSession(sessionId: string): NativeWebsiteAgentSession {
  if (!uuid.test(sessionId)) return invalid();
  return exportNativeWebsiteSession(SessionManager.inMemory(WEBSITE_AGENT_VIRTUAL_CWD, { id: sessionId }));
}

/** Host-only. No SessionManager file/discovery methods are used. */
export function openNativeWebsiteSession(snapshot: NativeWebsiteAgentSession): SessionManager {
  const id = snapshot.entries[0]?.id;
  if (typeof id !== "string") return invalid();
  const checked = parseNativeWebsiteSession(snapshot, id);
  const manager = SessionManager.inMemory(WEBSITE_AGENT_VIRTUAL_CWD, { id }, checked.entries);
  if (checked.leafId === null) manager.resetLeaf();
  else manager.branch(checked.leafId);
  return manager;
}

export function exportNativeWebsiteSession(manager: SessionManager): NativeWebsiteAgentSession {
  const header = manager.getHeader();
  if (!header || manager.isPersisted()) return invalid();
  return parseNativeWebsiteSession({ entries: [header, ...manager.getEntries()], leafId: manager.getLeafId() }, header.id);
}

/** Conservative room reservation before generation. Native compaction never deletes the archive. */
export function assertNativeSessionRoom(manager: SessionManager, extraBytes: number): void {
  if (byteSize({ entries: [manager.getHeader(), ...manager.getEntries()], leafId: manager.getLeafId() }) + extraBytes > WEBSITE_AGENT_NATIVE_SESSION_MAX_BYTES) {
    throw new WebsiteAgentError("session_full");
  }
}

export function appendInterruptedNativeWebsiteSession(snapshot: NativeWebsiteAgentSession, prompt: string, statusText: string): NativeWebsiteAgentSession {
  if (typeof prompt !== "string" || !prompt.trim() || typeof statusText !== "string" || !statusText.trim()) return invalid();
  const manager = openNativeWebsiteSession(snapshot);
  assertNativeSessionRoom(manager, byteSize({ prompt, statusText }) + 2048);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
  const assistant: AssistantMessage = { role: "assistant", content: [{ type: "text", text: statusText }], timestamp: Date.now(), api: "openai-completions", provider: "deepseek", model: "deepseek-flash", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  manager.appendMessage(assistant);
  return exportNativeWebsiteSession(manager);
}

/** UI projection of the complete selected native branch, including its compacted archive. */
export function websiteAgentSessionMessages(snapshot: NativeWebsiteAgentSession): Array<{ role: "user" | "assistant"; text: string }> {
  return openNativeWebsiteSession(snapshot).getBranch().flatMap(entry => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    return text.trim() ? [{ role: message.role, text }] : [];
  });
}

/** Native append-only continuation, allowing compaction checkpoints but no alteration of prior entries. */
export function assertNativeWebsiteSessionContinuation(prior: NativeWebsiteAgentSession, next: NativeWebsiteAgentSession, prompt: string, answer?: string): void {
  const id = prior.entries[0]?.id;
  if (typeof id !== "string") return invalid();
  const before = parseNativeWebsiteSession(prior, id);
  const after = parseNativeWebsiteSession(next, id);
  if (after.entries.length <= before.entries.length || !isDeepStrictEqual(after.entries.slice(0, before.entries.length), before.entries)) return invalid();
  let parentId = before.leafId;
  let userCount = 0;
  let finalText: string | undefined;
  for (const raw of after.entries.slice(before.entries.length)) {
    if (raw.type === "session" || raw.parentId !== parentId) return invalid();
    parentId = raw.id;
    if (raw.type !== "message") continue;
    if (finalText !== undefined) return invalid();
    if (raw.type === "message" && raw.message.role === "user") {
      userCount++;
      if (!isDeepStrictEqual(raw.message.content, [{ type: "text", text: prompt }])) return invalid();
    } else if (userCount !== 1) {
      return invalid();
    }
    if (raw.message.role === "assistant" && raw.message.stopReason === "stop" && !raw.message.content.some(part => part.type === "toolCall")) {
      finalText = raw.message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    }
  }
  if (userCount !== 1 || after.leafId !== parentId || !finalText || (answer !== undefined && finalText !== answer)) return invalid();
}
