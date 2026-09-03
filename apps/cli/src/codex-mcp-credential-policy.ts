import type { CommandInvocation } from "./command-runner";

/**
 * Forces Codex to use its direct OS keyring MCP credential backend.
 *
 * The Channel's isolated CODEX_HOME must not select a home-scoped file or
 * encrypted-secrets backend, otherwise an OAuth login performed by the user's
 * normal Codex installation would be invisible to the resident app-server.
 */
export const ATTENTION_MCP_CREDENTIAL_OVERRIDES = [
  'mcp_oauth_credentials_store="keyring"',
  "features.secret_auth_storage=false",
] as const;

function configArguments(overrides: readonly string[]): string[] {
  return overrides.flatMap((override) => ["-c", override]);
}

export function codexAttentionMcpOverrideArgs(mcpUrl: string): string[] {
  return configArguments([
    ...ATTENTION_MCP_CREDENTIAL_OVERRIDES,
    `mcp_servers.attention.url=${JSON.stringify(mcpUrl)}`,
  ]);
}

export function withCodexAttentionMcpPolicy(
  command: CommandInvocation,
  mcpUrl: string,
): CommandInvocation {
  return {
    args: [...codexAttentionMcpOverrideArgs(mcpUrl), ...command.args],
    executable: command.executable,
  };
}

/** Codex parses the exact two compatibility settings before printing version. */
export function codexAttentionMcpPolicyCheckCommand(): CommandInvocation {
  return {
    args: [
      ...configArguments(ATTENTION_MCP_CREDENTIAL_OVERRIDES),
      "--version",
    ],
    executable: "codex",
  };
}

export function parseCodexCliVersion(output: string): string | null {
  return (
    output.match(
      /\bcodex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)/iu,
    )?.[1] ?? null
  );
}
