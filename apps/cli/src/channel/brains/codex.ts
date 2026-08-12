import type { ATTENTION_MCP_TOOL_NAMES } from "@attention/contracts";

import {
  CodexAppServerRpc,
  type CodexAppServerRpcOptions,
} from "../codex-app-server-rpc";
import type { BrainAdapter } from "../brain";
import {
  createCodexResidentBrain,
  type CodexResidentRpc,
} from "./codex-resident";

const DISABLED_NON_ATTENTION_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "unified_exec",
  "workspace_dependencies",
] as const;

/** Minimal Attention capability surface required by the collection Channel. */
export const ATTENTION_CHANNEL_MCP_TOOL_NAMES = [
  "attention_get_my_account",
  "attention_list_collections",
  "attention_collect_content",
  "attention_submit_content_enrichment",
  "attention_select_collection_candidate",
  "attention_get_collection_status",
  "attention_update_collection",
] as const satisfies readonly (typeof ATTENTION_MCP_TOOL_NAMES)[number][];

/** Account-scoped writes explicitly approved by the Channel owner. */
export const ATTENTION_CHANNEL_APPROVED_WRITE_TOOLS = [
  "attention_collect_content",
  "attention_submit_content_enrichment",
  "attention_select_collection_candidate",
  "attention_update_collection",
] as const satisfies readonly (typeof ATTENTION_CHANNEL_MCP_TOOL_NAMES)[number][];

export interface CodexBrainOptions {
  readonly codexHomeDirectory?: string;
  readonly mcpUrl: string;
  readonly rpcFactory?: (options: CodexAppServerRpcOptions) => CodexResidentRpc;
}

/**
 * Creates the resident Codex app-server used by Attention Channel.
 *
 * CODEX_HOME is prepared by the caller and contains only auth.json. Global
 * feature disables and the explicit Attention MCP config are passed before
 * `app-server`; turn-level sandboxing is enforced by codex-resident.ts.
 */
export function createCodexBrain(options: CodexBrainOptions): BrainAdapter {
  const rpcOptions: CodexAppServerRpcOptions = {
    args: [
      ...DISABLED_NON_ATTENTION_FEATURES.flatMap((feature) => [
        "--disable",
        feature,
      ]),
      "-c",
      `mcp_servers.attention.url=${JSON.stringify(options.mcpUrl)}`,
      "-c",
      `mcp_servers.attention.enabled_tools=${JSON.stringify(ATTENTION_CHANNEL_MCP_TOOL_NAMES)}`,
      "-c",
      `web_search=${JSON.stringify("live")}`,
      ...ATTENTION_CHANNEL_APPROVED_WRITE_TOOLS.flatMap((tool) => [
        "-c",
        `mcp_servers.attention.tools.${tool}.approval_mode=${JSON.stringify("approve")}`,
      ]),
      "-c",
      `model=${JSON.stringify("gpt-5.6-luna")}`,
      "-c",
      `model_reasoning_effort=${JSON.stringify("medium")}`,
      "-c",
      `model_verbosity=${JSON.stringify("low")}`,
      "app-server",
      "--stdio",
    ],
    ...(options.codexHomeDirectory
      ? { environment: { CODEX_HOME: options.codexHomeDirectory } }
      : {}),
  };
  const rpc = (options.rpcFactory ?? ((input) => new CodexAppServerRpc(input)))(
    rpcOptions,
  );
  return createCodexResidentBrain({ mcpUrl: options.mcpUrl, rpc });
}
