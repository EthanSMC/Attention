import type { ATTENTION_MCP_TOOL_NAMES } from "@attention/contracts";

import { codexAttentionMcpOverrideArgs } from "../../codex-mcp-credential-policy";

import {
  CodexAppServerRpc,
  type CodexAppServerRpcOptions,
} from "../codex-app-server-rpc";
import type { BrainAdapter } from "../brain";
import type { CodexLocalControl } from "../codex-local-control";
import { browserPermissionFingerprint, type DedicatedBrowserConfiguration } from "../../dedicated-browser";

export const DEDICATED_BROWSER_TOOLS = ["attention_browser_open_collection", "attention_browser_read_article",
  "attention_browser_status", "attention_browser_show", "attention_browser_scroll", "attention_browser_close"] as const;
const BROWSER_ATTENTION_TOOLS = ["attention_issue_browser_grant", "attention_submit_private_browser_enrichment"] as const;
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
  "attention_read_collection_source",
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
  readonly dedicatedBrowser?: DedicatedBrowserConfiguration;
  readonly localControl?: CodexLocalControl;
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
  const browser = options.dedicatedBrowser;
  // A browser-enabled context may contain private evidence. Do not expose the
  // shared enrichment sink; a prompt alone is not an information-flow boundary.
  const attentionTools = ATTENTION_CHANNEL_MCP_TOOL_NAMES.filter(tool => !browser || tool !== "attention_submit_content_enrichment");
  const rpcOptions: CodexAppServerRpcOptions = {
    ...(options.localControl ? { cwd: options.localControl.workspace } : {}),
    args: [
      ...DISABLED_NON_ATTENTION_FEATURES.filter(feature => !options.localControl || (feature !== "shell_tool" && feature !== "unified_exec")).flatMap((feature) => [
        "--disable",
        feature,
      ]),
      ...(options.localControl ? ["--enable", "shell_tool", "--enable", "unified_exec"] : []),
      ...codexAttentionMcpOverrideArgs(options.mcpUrl),
      "-c",
      `mcp_servers.attention.enabled_tools=${JSON.stringify([...attentionTools, ...(browser ? BROWSER_ATTENTION_TOOLS : [])])}`,
      ...(browser ? ["-c", `mcp_servers.attention_browser.command=${JSON.stringify(browser.nodePath)}`,
        "-c", `mcp_servers.attention_browser.args=${JSON.stringify([browser.entryPath])}`,
        "-c", "mcp_servers.attention_browser.enabled=true",
        "-c", "mcp_servers.attention_browser.required=false",
        "-c", "mcp_servers.attention_browser.startup_timeout_sec=10",
        "-c", "mcp_servers.attention_browser.tool_timeout_sec=65",
        "-c", `mcp_servers.attention_browser.enabled_tools=${JSON.stringify(DEDICATED_BROWSER_TOOLS)}`,
        ...Object.entries({ ATTENTION_BROWSER_ORIGIN: browser.origin, ATTENTION_BROWSER_STATE_DIRECTORY: browser.stateDirectory,
          ATTENTION_BROWSER_CONSENT_VERSION: "1" }).flatMap(([key, value]) => ["-c", `mcp_servers.attention_browser.env.${key}=${JSON.stringify(value)}`]),
        ...[...BROWSER_ATTENTION_TOOLS].flatMap(tool => ["-c", `mcp_servers.attention.tools.${tool}.approval_mode="approve"`]),
        ...DEDICATED_BROWSER_TOOLS.flatMap(tool => ["-c", `mcp_servers.attention_browser.tools.${tool}.approval_mode="approve"`]),
      ] : []),
      "-c",
      `web_search=${JSON.stringify("live")}`,
      ...ATTENTION_CHANNEL_APPROVED_WRITE_TOOLS.filter(tool => !browser || tool !== "attention_submit_content_enrichment").flatMap((tool) => [
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
  return createCodexResidentBrain({ mcpUrl: options.mcpUrl, rpc, ...(options.localControl ? { localControl: options.localControl } : {}),
    ...(browser ? { dedicatedBrowser: true, permissionProfileSha256: browserPermissionFingerprint(browser) } : {}) });
}
