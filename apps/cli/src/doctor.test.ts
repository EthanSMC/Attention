import { describe, expect, it } from "vitest";

import {
  ATTENTION_MCP_OAUTH_SCOPES,
  ATTENTION_MCP_TOOL_NAMES,
} from "@attention/contracts";

import type { CommandRunner } from "./command-runner";
import { doctorExitCode, runDoctor } from "./doctor";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

describe("doctor", () => {
  it("does not accept a config-only Codex probe as live MCP evidence", async () => {
    const invocations: string[] = [];
    const runner: CommandRunner = async (invocation) => {
      invocations.push([invocation.executable, ...invocation.args].join(" "));
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: invocation.args.includes("--version")
          ? "codex-cli 1.2.3"
          : invocation.args.join(" ") === "mcp list --json"
            ? JSON.stringify([
                {
                  auth_status: "oauth",
                  enabled: true,
                  name: "attention",
                  transport: {
                    type: "streamable_http",
                    url: "https://attention.example/mcp",
                  },
                },
              ])
            : "ok",
        timedOut: false,
      };
    };
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/mcp")) {
        return new Response(null, {
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://attention.example/.well-known/oauth-protected-resource"',
          },
          status: 401,
        });
      }
      return jsonResponse({
        authorization_servers: ["https://attention.example"],
        resource: "https://attention.example/mcp",
        scopes_supported: ATTENTION_MCP_OAUTH_SCOPES,
      });
    };

    const checks = await runDoctor({
      compatibilityInvocations: [
        { args: ["mcp", "add", "--help"], executable: "codex" },
        { args: ["mcp", "get", "--help"], executable: "codex" },
      ],
      fetchImpl: fetchImpl as typeof fetch,
      hostId: "codex",
      loginInvocation: {
        args: ["mcp", "login", "attention"],
        executable: "codex",
      },
      mcpUrl: "https://attention.example/mcp",
      minimumVersion: null,
      probe: true,
      probeEvidence: "config_only",
      probeInvocation: {
        args: ["mcp", "get", "attention"],
        executable: "codex",
      },
      runner,
      versionInvocation: { args: ["--version"], executable: "codex" },
    });

    expect(checks.map((check) => check.status)).toEqual([
      "warn",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "fail",
    ]);
    expect(doctorExitCode(checks)).toBe(1);
    expect(invocations).toContain("codex mcp login attention --help");
    expect(invocations).toContain("codex mcp add --help");
    expect(invocations).toContain("codex mcp get attention");
    expect(invocations).toContain("codex mcp list --json");
    expect(invocations).not.toContain("codex mcp login attention");
    expect(checks.find((check) => check.id === "host_mcp_probe")?.detail).toMatch(
      /cannot prove tools\/list or live tool availability/u,
    );
  });

  it("fails explicitly when Codex reports that Attention OAuth is not logged in", async () => {
    const checks = await runDoctor({
      compatibilityInvocations: [],
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/mcp")
          ? new Response(null, {
              headers: {
                "WWW-Authenticate": "Bearer resource_metadata=x",
              },
              status: 401,
            })
          : jsonResponse({
              authorization_servers: ["https://attention.example"],
              resource: "https://attention.example/mcp",
              scopes_supported: ATTENTION_MCP_OAUTH_SCOPES,
            })) as typeof fetch,
      hostId: "codex",
      loginInvocation: {
        args: ["mcp", "login", "attention"],
        executable: "codex",
      },
      mcpUrl: "https://attention.example/mcp",
      minimumVersion: null,
      probe: true,
      probeEvidence: "config_only",
      probeInvocation: {
        args: ["mcp", "get", "attention", "--json"],
        executable: "codex",
      },
      runner: async (invocation) => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout:
          invocation.args.join(" ") === "mcp list --json"
            ? JSON.stringify([
                {
                  auth_status: "not_logged_in",
                  enabled: true,
                  name: "attention",
                  transport: {
                    type: "streamable_http",
                    url: "https://attention.example/mcp",
                  },
                },
              ])
            : "ok",
        timedOut: false,
      }),
      versionInvocation: null,
    });

    expect(checks.find((check) => check.id === "host_oauth_session")).toEqual(
      expect.objectContaining({
        detail: expect.stringMatching(/not logged in/u),
        status: "fail",
      }),
    );
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("reads the complete Attention entry from safely truncated Codex list output", async () => {
    const checks = await runDoctor({
      compatibilityInvocations: [],
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/mcp")
          ? new Response(null, {
              headers: {
                "WWW-Authenticate": "Bearer resource_metadata=x",
              },
              status: 401,
            })
          : jsonResponse({
              authorization_servers: ["https://attention.example"],
              resource: "https://attention.example/mcp",
              scopes_supported: ATTENTION_MCP_OAUTH_SCOPES,
            })) as typeof fetch,
      hostId: "codex",
      loginInvocation: null,
      mcpUrl: "https://attention.example/mcp",
      minimumVersion: null,
      probe: true,
      probeEvidence: "config_only",
      probeInvocation: {
        args: ["mcp", "get", "attention", "--json"],
        executable: "codex",
      },
      runner: async (invocation) => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout:
          invocation.args.join(" ") === "mcp list --json"
            ? `[${JSON.stringify({
                auth_status: "oauth",
                enabled: true,
                name: "attention",
                transport: {
                  type: "streamable_http",
                  url: "https://attention.example/mcp",
                },
              })}, {"name":"another", "transport":\n… output truncated`
            : "ok",
        timedOut: false,
      }),
      versionInvocation: null,
    });

    expect(checks.find((check) => check.id === "host_oauth_session")).toEqual(
      expect.objectContaining({ status: "pass" }),
    );
  });

  it("rejects protected-resource metadata that omits required MCP scopes", async () => {
    const checks = await runDoctor({
      compatibilityInvocations: [],
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/mcp")
          ? new Response(null, {
              headers: {
                "WWW-Authenticate": "Bearer resource_metadata=x",
              },
              status: 401,
            })
          : jsonResponse({
              authorization_servers: ["https://attention.example"],
              resource: "https://attention.example/mcp",
              scopes_supported: [
                "profile:read",
                "collection:read",
                "collection:write",
                "public:read",
                "public:full",
                "ai:search",
              ],
            })) as typeof fetch,
      hostId: "hermes",
      loginInvocation: null,
      mcpUrl: "https://attention.example/mcp",
      minimumVersion: null,
      probe: false,
      probeEvidence: "health_checked",
      probeInvocation: null,
      runner: async () => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "ok",
        timedOut: false,
      }),
      versionInvocation: null,
    });

    const metadata = checks.find((check) => check.id === "oauth_metadata");
    expect(metadata).toEqual(
      expect.objectContaining({
        detail: expect.stringContaining("digest:read"),
        status: "fail",
      }),
    );
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("requires live-tools probes to return the complete tools/list contract", async () => {
    const checks = await runDoctor({
      compatibilityInvocations: [],
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/mcp")
          ? new Response(null, {
              headers: {
                "WWW-Authenticate": "Bearer resource_metadata=x",
              },
              status: 401,
            })
          : jsonResponse({
              authorization_servers: ["https://attention.example"],
              resource: "https://attention.example/mcp",
              scopes_supported: ATTENTION_MCP_OAUTH_SCOPES,
            })) as typeof fetch,
      hostId: "hermes",
      loginInvocation: null,
      mcpUrl: "https://attention.example/mcp",
      minimumVersion: null,
      probe: true,
      probeEvidence: "live_tools",
      probeInvocation: {
        args: ["mcp", "tools", "attention", "--json"],
        executable: "hermes",
      },
      runner: async (invocation) => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout:
          invocation.args[1] === "tools"
            ? JSON.stringify({
                result: {
                  tools: ATTENTION_MCP_TOOL_NAMES.slice(0, -1).map((name) => ({
                    name,
                  })),
                },
              })
            : "ok",
        timedOut: false,
      }),
      versionInvocation: null,
    });

    expect(checks.find((check) => check.id === "host_mcp_probe")).toEqual(
      expect.objectContaining({
        detail: expect.stringContaining("attention_update_digest_settings"),
        status: "fail",
      }),
    );
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("does not claim that WorkBuddy exposes a binding-status API", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith("/mcp")) {
        return new Response(null, {
          headers: { "WWW-Authenticate": "Bearer resource_metadata=x" },
          status: 401,
        });
      }
      return jsonResponse({
        authorization_servers: ["https://attention.example"],
        resource: "https://attention.example/mcp",
        scopes_supported: ATTENTION_MCP_OAUTH_SCOPES,
      });
    };
    const checks = await runDoctor({
      compatibilityInvocations: [],
      fetchImpl: fetchImpl as typeof fetch,
      hostId: "workbuddy",
      loginInvocation: null,
      mcpUrl: "https://attention.example/mcp",
      minimumVersion: null,
      probe: true,
      probeEvidence: "none",
      probeInvocation: null,
      runner: async () => {
        throw new Error("WorkBuddy doctor must not invoke a guessed CLI");
      },
      versionInvocation: null,
    });
    expect(checks.find((check) => check.id === "host_version")).toMatchObject({
      status: "warn",
    });
    expect(checks.find((check) => check.id === "host_mcp_probe")?.detail).toMatch(
      /No supported CLI probe/,
    );
    expect(checks.map((check) => check.detail).join(" ")).not.toMatch(
      /WeChat connected|微信已连接/,
    );
  });

  it("rejects a host older than the manifest minimum", async () => {
    const checks = await runDoctor({
      compatibilityInvocations: [],
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/mcp")
          ? new Response(null, {
              headers: { "WWW-Authenticate": "Bearer resource_metadata=x" },
              status: 401,
            })
          : jsonResponse({
              authorization_servers: ["https://attention.example"],
              resource: "https://attention.example/mcp",
              scopes_supported: ATTENTION_MCP_OAUTH_SCOPES,
            })) as typeof fetch,
      hostId: "claude-code",
      loginInvocation: {
        args: ["mcp", "login", "attention"],
        executable: "claude",
      },
      mcpUrl: "https://attention.example/mcp",
      minimumVersion: "2.1.80",
      probe: false,
      probeEvidence: "config_only",
      probeInvocation: null,
      runner: async (invocation) => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: invocation.args.includes("--version")
          ? "2.1.79"
          : "help",
        timedOut: false,
      }),
      versionInvocation: { args: ["--version"], executable: "claude" },
    });
    expect(checks.find((check) => check.id === "host_version")).toMatchObject({
      status: "fail",
    });
    expect(doctorExitCode(checks)).toBe(1);
  });
});
