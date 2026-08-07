import {
  ATTENTION_MCP_OAUTH_SCOPES,
  ATTENTION_MCP_TOOL_NAMES,
  type AgentInstallationProfile,
  type AgentIntegrationId,
} from "@attention/contracts";

import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "./command-runner";
import { formatInvocation, runCommand } from "./command-runner";

export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";

const MAXIMUM_METADATA_BYTES = 131_072;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  "gu",
);

export interface DiagnosticCheck {
  readonly detail: string;
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly title: string;
}

export interface DoctorInput {
  readonly compatibilityInvocations: readonly CommandInvocation[];
  readonly fetchImpl?: typeof fetch;
  readonly hostId: AgentIntegrationId;
  readonly loginInvocation: CommandInvocation | null;
  readonly mcpUrl: string;
  readonly minimumVersion: string | null;
  readonly probe: boolean;
  readonly probeEvidence: AgentInstallationProfile["mcp"]["probe_evidence"];
  readonly probeInvocation: CommandInvocation | null;
  readonly runner?: CommandRunner;
  readonly versionInvocation: CommandInvocation | null;
}

async function checkHostCapabilities(
  invocations: readonly CommandInvocation[],
  runner: CommandRunner,
): Promise<DiagnosticCheck> {
  if (invocations.length === 0) {
    return {
      detail:
        "Compatibility is governed by the manifest's pinned minimum version.",
      id: "host_capabilities",
      status: "skip",
      title: "Host command capabilities",
    };
  }
  for (const invocation of invocations) {
    const result = await runner(invocation, { timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      return {
        detail: `${formatInvocation(invocation)} is unavailable: ${commandFailureDetail(result)}`,
        id: "host_capabilities",
        status: "fail",
        title: "Host command capabilities",
      };
    }
  }
  return {
    detail: `Verified ${invocations.length} required non-destructive command surface${invocations.length === 1 ? "" : "s"}.`,
    id: "host_capabilities",
    status: "pass",
    title: "Host command capabilities",
  };
}

function versionParts(value: string): readonly number[] | null {
  const match = value.match(/\d+(?:\.\d+){1,3}/);
  if (!match) return null;
  return match[0].split(".").map((part) => Number(part));
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function commandFailureDetail(result: CommandResult): string {
  if (result.timedOut) return "Command timed out.";
  const output = result.stderr || result.stdout;
  return output || `Command exited with code ${String(result.exitCode)}.`;
}

async function checkHostVersion(
  hostId: AgentIntegrationId,
  minimumVersion: string | null,
  invocation: CommandInvocation | null,
  runner: CommandRunner,
): Promise<DiagnosticCheck> {
  if (!invocation) {
    return {
      detail:
        hostId === "workbuddy"
          ? "WorkBuddy is configured in its desktop UI. Attention cannot read its installed version or WeChat binding state."
          : "This profile exposes no verified host version command.",
      id: "host_version",
      status: "warn",
      title: "Host version",
    };
  }
  const result = await runner(invocation, { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    return {
      detail: commandFailureDetail(result),
      id: "host_version",
      status: "fail",
      title: "Host version",
    };
  }
  const output = (result.stdout || result.stderr).split("\n")[0] || "Detected.";
  if (minimumVersion) {
    const installed = versionParts(output);
    const minimum = versionParts(minimumVersion);
    if (!installed || !minimum) {
      return {
        detail: `${output}. Could not compare it with required version ${minimumVersion}; verify manually.`,
        id: "host_version",
        status: "warn",
        title: "Host version",
      };
    }
    if (compareVersions(installed, minimum) < 0) {
      return {
        detail: `${output}. This integration requires ${minimumVersion} or newer.`,
        id: "host_version",
        status: "fail",
        title: "Host version",
      };
    }
  }
  return {
    detail: minimumVersion
      ? `${output} (meets minimum ${minimumVersion}).`
      : `${output}. No minimum version is pinned; command capability checks remain authoritative.`,
    id: "host_version",
    status: minimumVersion ? "pass" : "warn",
    title: "Host version",
  };
}

function protectedResourceMetadataUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  return new URL("/.well-known/oauth-protected-resource", url.origin).toString();
}

async function safeFetch(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Response> {
  return await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "attention-cli-doctor/0.1",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
  });
}

async function checkMcpEndpoint(
  fetchImpl: typeof fetch,
  mcpUrl: string,
): Promise<DiagnosticCheck> {
  try {
    const response = await safeFetch(fetchImpl, mcpUrl);
    const authenticate = response.headers.get("www-authenticate") ?? "";
    if (response.status === 401 && /resource_metadata=/i.test(authenticate)) {
      return {
        detail: "Reachable and advertises OAuth protected-resource metadata.",
        id: "mcp_endpoint",
        status: "pass",
        title: "MCP endpoint",
      };
    }
    if ([200, 400, 405].includes(response.status)) {
      return {
        detail: `Reachable (HTTP ${response.status}), but the unauthenticated response did not advertise the expected OAuth challenge.`,
        id: "mcp_endpoint",
        status: "warn",
        title: "MCP endpoint",
      };
    }
    return {
      detail: `Unexpected HTTP ${response.status}.`,
      id: "mcp_endpoint",
      status: "fail",
      title: "MCP endpoint",
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : "Network request failed.",
      id: "mcp_endpoint",
      status: "fail",
      title: "MCP endpoint",
    };
  }
}

async function checkOAuthMetadata(
  fetchImpl: typeof fetch,
  mcpUrl: string,
): Promise<DiagnosticCheck> {
  const metadataUrl = protectedResourceMetadataUrl(mcpUrl);
  try {
    const response = await safeFetch(fetchImpl, metadataUrl);
    if (!response.ok) {
      return {
        detail: `Protected-resource metadata returned HTTP ${response.status}.`,
        id: "oauth_metadata",
        status: "fail",
        title: "OAuth metadata",
      };
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAXIMUM_METADATA_BYTES) {
      throw new Error("Protected-resource metadata exceeds 128 KiB.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAXIMUM_METADATA_BYTES) {
      throw new Error("Protected-resource metadata exceeds 128 KiB.");
    }
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const resource =
      typeof body === "object" && body !== null && "resource" in body
        ? Reflect.get(body, "resource")
        : null;
    const authorizationServers =
      typeof body === "object" && body !== null && "authorization_servers" in body
        ? Reflect.get(body, "authorization_servers")
        : null;
    const supportedScopes =
      typeof body === "object" && body !== null && "scopes_supported" in body
        ? Reflect.get(body, "scopes_supported")
        : null;
    if (
      resource !== mcpUrl ||
      !Array.isArray(authorizationServers) ||
      authorizationServers.length === 0
    ) {
      return {
        detail:
          "Metadata is reachable but its resource or authorization_servers value does not match this MCP endpoint.",
        id: "oauth_metadata",
        status: "fail",
        title: "OAuth metadata",
      };
    }
    if (
      !Array.isArray(supportedScopes) ||
      supportedScopes.some((scope) => typeof scope !== "string")
    ) {
      return {
        detail:
          "Metadata does not publish a valid scopes_supported array for the MCP audience.",
        id: "oauth_metadata",
        status: "fail",
        title: "OAuth metadata",
      };
    }
    const supportedScopeSet = new Set<string>(supportedScopes);
    const missingScopes = ATTENTION_MCP_OAUTH_SCOPES.filter(
      (scope) => !supportedScopeSet.has(scope),
    );
    if (missingScopes.length > 0) {
      return {
        detail: `Metadata is missing required MCP scopes: ${missingScopes.join(", ")}. The deployment is older than the installation contract.`,
        id: "oauth_metadata",
        status: "fail",
        title: "OAuth metadata",
      };
    }
    return {
      detail: `Audience matches ${mcpUrl} and publishes all ${String(ATTENTION_MCP_OAUTH_SCOPES.length)} required MCP scopes.`,
      id: "oauth_metadata",
      status: "pass",
      title: "OAuth metadata",
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : "Metadata request failed.",
      id: "oauth_metadata",
      status: "fail",
      title: "OAuth metadata",
    };
  }
}

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, "");
}

function parseCodexMcpList(
  value: string,
): readonly Record<string, unknown>[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    if (
      parsed.some(
        (entry) => typeof entry !== "object" || entry === null || Array.isArray(entry),
      )
    ) {
      return null;
    }
    return parsed as readonly Record<string, unknown>[];
  } catch {
    // Command output is deliberately bounded before diagnostics consume it.
    // Codex prints the requested server near the beginning of its JSON array,
    // so retain complete top-level objects without accepting an incomplete
    // object or increasing the global diagnostic-output limit.
    const entries: Record<string, unknown>[] = [];
    const arrayStart = value.indexOf("[");
    if (arrayStart < 0) return null;
    let objectStart = -1;
    let objectDepth = 0;
    let inString = false;
    let escaped = false;
    for (let index = arrayStart + 1; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") {
        if (objectDepth === 0) objectStart = index;
        objectDepth += 1;
        continue;
      }
      if (character !== "}" || objectDepth === 0) continue;
      objectDepth -= 1;
      if (objectDepth !== 0 || objectStart < 0) continue;
      try {
        const entry: unknown = JSON.parse(value.slice(objectStart, index + 1));
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
          entries.push(entry as Record<string, unknown>);
        }
      } catch {
        return entries.length > 0 ? entries : null;
      }
      objectStart = -1;
    }
    return entries.length > 0 ? entries : null;
  }
}

async function checkHostOAuthSession(
  hostId: AgentIntegrationId,
  mcpUrl: string,
  probe: boolean,
  runner: CommandRunner,
): Promise<DiagnosticCheck> {
  if (!probe) {
    return {
      detail:
        "OAuth session state is checked only when --probe is explicitly requested.",
      id: "host_oauth_session",
      status: "skip",
      title: "Host OAuth session",
    };
  }

  if (hostId === "codex") {
    const result = await runner(
      { args: ["mcp", "list", "--json"], executable: "codex" },
      { timeoutMs: 20_000 },
    );
    if (result.exitCode !== 0) {
      return {
        detail: `Could not inspect Codex OAuth state: ${commandFailureDetail(result)}`,
        id: "host_oauth_session",
        status: "fail",
        title: "Host OAuth session",
      };
    }
    const entries = parseCodexMcpList(result.stdout || result.stderr);
    const attention = entries?.find((entry) => entry.name === "attention");
    if (!attention) {
      return {
        detail:
          "Codex did not return a machine-readable Attention MCP entry.",
        id: "host_oauth_session",
        status: "fail",
        title: "Host OAuth session",
      };
    }
    const transport = attention.transport;
    const configuredUrl =
      typeof transport === "object" && transport !== null && "url" in transport
        ? Reflect.get(transport, "url")
        : null;
    if (attention.enabled !== true || configuredUrl !== mcpUrl) {
      return {
        detail:
          "Codex has no enabled Attention MCP entry targeting this deployment.",
        id: "host_oauth_session",
        status: "fail",
        title: "Host OAuth session",
      };
    }
    if (attention.auth_status !== "oauth") {
      return {
        detail:
          attention.auth_status === "not_logged_in"
            ? "Codex reports that Attention OAuth is not logged in. Run `codex mcp login attention` and retry."
            : "Codex does not report an authenticated OAuth session for Attention.",
        id: "host_oauth_session",
        status: "fail",
        title: "Host OAuth session",
      };
    }
    return {
      detail:
        "Codex reports an authenticated Attention OAuth session for the configured MCP URL.",
      id: "host_oauth_session",
      status: "pass",
      title: "Host OAuth session",
    };
  }

  if (hostId === "claude-code") {
    const result = await runner(
      { args: ["mcp", "list"], executable: "claude" },
      { timeoutMs: 20_000 },
    );
    if (result.exitCode !== 0) {
      return {
        detail: `Claude Code could not health-check configured MCP servers: ${commandFailureDetail(result)}`,
        id: "host_oauth_session",
        status: "fail",
        title: "Host OAuth session",
      };
    }
    const attentionLine = stripAnsi(result.stdout || result.stderr)
      .split("\n")
      .find((line) => /^attention\s*:/u.test(line.trim()));
    if (!attentionLine || !/\bConnected\b/iu.test(attentionLine)) {
      return {
        detail:
          "Claude Code did not report Attention as connected during its MCP health check.",
        id: "host_oauth_session",
        status: "fail",
        title: "Host OAuth session",
      };
    }
    return {
      detail:
        "Claude Code reports Attention as connected; the separate configuration probe still cannot enumerate tools/list.",
      id: "host_oauth_session",
      status: "pass",
      title: "Host OAuth session",
    };
  }

  return {
    detail:
      "This host has no separate, verified OAuth-session status command; its MCP probe remains authoritative.",
    id: "host_oauth_session",
    status: "skip",
    title: "Host OAuth session",
  };
}

async function checkLoginCapability(
  invocation: CommandInvocation | null,
  runner: CommandRunner,
): Promise<DiagnosticCheck> {
  if (!invocation) {
    return {
      detail:
        "This host uses a UI-managed OAuth flow; complete it inside the host instead of running a login command.",
      id: "oauth_login",
      status: "warn",
      title: "OAuth login capability",
    };
  }
  const helpInvocation = {
    ...invocation,
    args: [...invocation.args, "--help"],
  };
  const result = await runner(helpInvocation, { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    return {
      detail: commandFailureDetail(result),
      id: "oauth_login",
      status: "fail",
      title: "OAuth login capability",
    };
  }
  return {
    detail: `Available: ${formatInvocation(invocation)} (not executed by doctor).`,
    id: "oauth_login",
    status: "pass",
    title: "OAuth login capability",
  };
}

async function checkConfiguredMcp(
  probe: boolean,
  evidence: AgentInstallationProfile["mcp"]["probe_evidence"],
  invocation: CommandInvocation | null,
  runner: CommandRunner,
): Promise<DiagnosticCheck> {
  if (!probe) {
    return {
      detail: invocation
        ? evidence === "config_only"
          ? `Run again with --probe to inspect saved configuration: ${formatInvocation(invocation)}. This does not prove network, OAuth, or tool availability.`
          : `Run again with --probe to execute: ${formatInvocation(invocation)}`
        : "This host exposes no supported CLI probe. Check the MCP connection in its UI.",
      id: "host_mcp_probe",
      status: "skip",
      title: "Host MCP probe",
    };
  }
  if (!invocation) {
    return {
      detail:
        "No supported CLI probe exists for this host. Attention does not infer a connection from undocumented local state.",
      id: "host_mcp_probe",
      status: "warn",
      title: "Host MCP probe",
    };
  }
  const result = await runner(invocation, { timeoutMs: 20_000 });
  if (result.exitCode !== 0) {
    return {
      detail: commandFailureDetail(result),
      id: "host_mcp_probe",
      status: "fail",
      title: "Host MCP probe",
    };
  }
  if (evidence === "config_only") {
    return {
      detail:
        "Configuration is present, but this probe cannot prove tools/list or live tool availability. A --probe run is incomplete until the host exposes a live MCP probe.",
      id: "host_mcp_probe",
      status: "fail",
      title: "Host MCP configuration",
    };
  }
  if (evidence === "live_tools") {
    let body: unknown;
    try {
      body = JSON.parse(result.stdout || result.stderr);
    } catch {
      return {
        detail:
          "The live-tools probe passed but did not return machine-readable tools/list JSON.",
        id: "host_mcp_probe",
        status: "fail",
        title: "Host MCP live tools",
      };
    }
    const tools =
      typeof body === "object" && body !== null && "result" in body
        ? (() => {
            const nested = Reflect.get(body, "result");
            return typeof nested === "object" &&
              nested !== null &&
              "tools" in nested
              ? Reflect.get(nested, "tools")
              : null;
          })()
        : typeof body === "object" && body !== null && "tools" in body
          ? Reflect.get(body, "tools")
          : null;
    if (!Array.isArray(tools)) {
      return {
        detail: "The live-tools probe response has no tools/list inventory.",
        id: "host_mcp_probe",
        status: "fail",
        title: "Host MCP live tools",
      };
    }
    const toolNames = new Set(
      tools.flatMap((tool) =>
        typeof tool === "object" &&
        tool !== null &&
        "name" in tool &&
        typeof Reflect.get(tool, "name") === "string"
          ? [Reflect.get(tool, "name") as string]
          : [],
      ),
    );
    const missingTools = ATTENTION_MCP_TOOL_NAMES.filter(
      (name) => !toolNames.has(name),
    );
    if (missingTools.length > 0) {
      return {
        detail: `Live tools/list is missing required tools: ${missingTools.join(", ")}.`,
        id: "host_mcp_probe",
        status: "fail",
        title: "Host MCP live tools",
      };
    }
    return {
      detail: `Live tools/list contains all ${String(ATTENTION_MCP_TOOL_NAMES.length)} required Attention tools.`,
      id: "host_mcp_probe",
      status: "pass",
      title: "Host MCP live tools",
    };
  }
  return {
    detail:
      "The host reached Attention with its saved authentication. This health probe does not independently enumerate tools/list.",
    id: "host_mcp_probe",
    status: "pass",
    title: "Host MCP health",
  };
}

export async function runDoctor(input: DoctorInput): Promise<readonly DiagnosticCheck[]> {
  const runner = input.runner ?? runCommand;
  const fetchImpl = input.fetchImpl ?? fetch;
  return await Promise.all([
    checkHostVersion(
      input.hostId,
      input.minimumVersion,
      input.versionInvocation,
      runner,
    ),
    checkHostCapabilities(input.compatibilityInvocations, runner),
    checkMcpEndpoint(fetchImpl, input.mcpUrl),
    checkOAuthMetadata(fetchImpl, input.mcpUrl),
    checkLoginCapability(input.loginInvocation, runner),
    checkHostOAuthSession(input.hostId, input.mcpUrl, input.probe, runner),
    checkConfiguredMcp(
      input.probe,
      input.probeEvidence,
      input.probeInvocation,
      runner,
    ),
  ]);
}

export function doctorExitCode(checks: readonly DiagnosticCheck[]): number {
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}
