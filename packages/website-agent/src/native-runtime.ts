import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createExtensionRuntime, type Extension, type MessageEndEvent, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { REDACTED_TOOL_RESULT } from "./session.js";

/** Per-run evidence never serialized or shared between accounts. */
export class TransientWebsiteEvidence {
  readonly results = new Map<string, ToolResultMessage>();
  readonly assistants = new Map<string, AssistantMessage>();
  arguments = new WeakMap<object, unknown>();
  clear(): void { this.results.clear(); this.assistants.clear(); this.arguments = new WeakMap(); }
}

/** Native transformContext: raw evidence is available only during its current authorized run. */
export function hydrateWebsiteMessages(messages: AgentMessage[], transient: TransientWebsiteEvidence): AgentMessage[] {
  return messages.map(message => {
    if (message.role === "toolResult") return structuredClone(transient.results.get(message.toolCallId) ?? message);
    if (message.role === "assistant") {
      const call = message.content.find(part => part.type === "toolCall");
      if (call?.type === "toolCall") return structuredClone(transient.assistants.get(call.id) ?? message);
    }
    return message;
  });
}

/** Explicit resource implementation: never calls default discovery, filesystem loaders, or extension loaders. */
export function createWebsiteResourceLoader(systemPrompt: string, transient: TransientWebsiteEvidence): ResourceLoader {
  const extension: Extension = {
    path: "<attention-session-safety>", resolvedPath: "<attention-session-safety>", hidden: true,
    sourceInfo: { path: "<attention-session-safety>", source: "attention", scope: "temporary", origin: "top-level" },
    handlers: new Map(), tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  extension.handlers.set("message_end", [async (raw) => {
    const { message } = raw as MessageEndEvent;
    if (message.role === "toolResult") {
      transient.results.set(message.toolCallId, structuredClone(message));
      return { message: {
        role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName, timestamp: message.timestamp,
        isError: message.isError, content: [{ type: "text", text: REDACTED_TOOL_RESULT }], details: {},
      } };
    }
    if (message.role === "assistant") {
      const calls = message.content.filter(part => part.type === "toolCall");
      // Preserve the authorized current turn for model replay, with reasoning removed.
      if (calls.length) {
        const replay: AssistantMessage = { ...message, content: message.content.filter(part => part.type !== "thinking") };
        for (const call of calls) transient.assistants.set(call.id, structuredClone(replay));
      }
      const content: AssistantMessage["content"] = calls.map(call => {
        const redacted = {};
        // prepareArguments restores this exact object before native validation/execution.
        // An old stored call has no WeakMap entry and can never regain its arguments.
        transient.arguments.set(redacted, call.arguments);
        return { type: "toolCall", id: call.id, name: call.name, arguments: redacted };
      });
      if (message.stopReason === "stop" && calls.length === 0) {
        content.push(...message.content.filter(part => part.type === "text").map(part => ({ type: "text" as const, text: part.text })));
      }
      return { message: {
        role: "assistant", content,
        api: "openai-completions", provider: "deepseek", model: "deepseek-flash", timestamp: message.timestamp,
        usage: message.usage, stopReason: message.stopReason,
        ...(message.errorMessage ? { errorMessage: "The model request did not complete." } : {}),
      } };
    }
    if (message.role === "user") {
      return { message: { role: "user", content: typeof message.content === "string" ? [{ type: "text", text: message.content }]
        : message.content.filter(part => part.type === "text").map(part => ({ type: "text", text: part.text })), timestamp: message.timestamp } };
    }
    return undefined;
  }]);
  const result = { extensions: [extension], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => result,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Website resource discovery is disabled"); },
    reload: async () => {},
  };
}
