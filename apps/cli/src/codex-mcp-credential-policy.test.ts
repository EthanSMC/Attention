import { describe, expect, it } from "vitest";

import {
  ATTENTION_MCP_CREDENTIAL_OVERRIDES,
  codexAttentionMcpOverrideArgs,
  codexAttentionMcpPolicyCheckCommand,
  parseCodexCliVersion,
} from "./codex-mcp-credential-policy";

describe("Codex Attention MCP credential policy", () => {
  it("uses the direct keyring backend and disables home-scoped secret storage", () => {
    expect(ATTENTION_MCP_CREDENTIAL_OVERRIDES).toEqual([
      'mcp_oauth_credentials_store="keyring"',
      "features.secret_auth_storage=false",
    ]);
    expect(
      codexAttentionMcpOverrideArgs("https://attention.example/mcp"),
    ).toEqual([
      "-c",
      'mcp_oauth_credentials_store="keyring"',
      "-c",
      "features.secret_auth_storage=false",
      "-c",
      'mcp_servers.attention.url="https://attention.example/mcp"',
    ]);
  });

  it("checks support by asking Codex to parse the exact overrides", () => {
    expect(codexAttentionMcpPolicyCheckCommand()).toEqual({
      executable: "codex",
      args: [
        "-c",
        'mcp_oauth_credentials_store="keyring"',
        "-c",
        "features.secret_auth_storage=false",
        "--version",
      ],
    });
  });

  it.each([
    ["codex-cli 0.151.0-alpha.7.2", "0.151.0-alpha.7.2"],
    ["codex 1.2.3", "1.2.3"],
    ["unknown", null],
  ])("parses Codex version output %s", (output, expected) => {
    expect(parseCodexCliVersion(output)).toBe(expected);
  });
});
