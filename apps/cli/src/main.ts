import {
  AgentIntegrationIdSchema,
  type AgentCapabilityAvailability,
  type AgentIntegrationId,
} from "@attention/contracts";

import {
  channelLogout,
  channelStart,
  channelStatus,
} from "./channel/channel-command";
import {
  type ApplyConfigureOptions,
  type ApplyResult,
  applyConfigurePlan,
  buildConfigurePlan,
  listAgentIntegrations,
} from "./configure";
import { formatInvocation } from "./command-runner";
import {
  type DiagnosticCheck,
  type DoctorInput,
  doctorExitCode,
  runDoctor,
} from "./doctor";
import { requireAttentionOrigin } from "./origin";
import type { RuntimeAuthorizer } from "./runtime-oauth";

const CLI_VERSION = "0.1.0";

interface OutputWriter {
  readonly error: (value: string) => void;
  readonly log: (value: string) => void;
}

export interface AttentionCliDependencies {
  readonly applyConfigure?: (
    plan: ReturnType<typeof buildConfigurePlan>,
    options: ApplyConfigureOptions,
  ) => Promise<readonly ApplyResult[]>;
  readonly authorizeRuntime?: RuntimeAuthorizer;
  readonly environment?: NodeJS.ProcessEnv;
  readonly output?: OutputWriter;
  readonly runChannel?: (input: {
    readonly action: "logout" | "start" | "status";
    readonly background: boolean;
    readonly hostId: string | null;
    readonly json: boolean;
    readonly origin?: string;
    readonly service: boolean;
  }) => Promise<number>;
  readonly runDoctorChecks?: (
    input: DoctorInput,
  ) => Promise<readonly DiagnosticCheck[]>;
}

interface ParsedOptions {
  readonly apply: boolean;
  readonly background: boolean;
  readonly forceSkill: boolean;
  readonly json: boolean;
  readonly login: boolean;
  readonly origin: string | undefined;
  readonly positionals: readonly string[];
  readonly probe: boolean;
  readonly service: boolean;
  readonly skillDirectory: string | undefined;
}

const HELP = `Attention local Agent installer and diagnostics

Usage:
  attention integrations [list] [--json]
  attention configure <host> --origin <https-origin> [--skill-dir <path>]
                      [--apply] [--login] [--force-skill] [--json]
  attention doctor <host> --origin <https-origin> [--probe] [--json]
  attention channel start <codex|claude-code> --origin <https-origin>
                          [--background]
  attention channel status [--json]
  attention channel logout

Hosts:
  openclaw  hermes  codex  claude-code  workbuddy

Channel:
  attention channel start runs the local attention-channel bridge: after a
  one-time QR scan it polls WeChat through the official iLink API and
  invokes the selected host Agent in a restricted profile (Attention MCP
  only; shell, code execution, filesystem write, and other MCP denied).
  Sending a link or share text into that WeChat conversation collects it.
  OpenClaw, Hermes, and WorkBuddy use their host-managed WeChat channels
  instead; see attention configure <host> output and /doc/<host>.

Safety:
  configure is a dry run by default. --apply installs, stages, or downloads
  the public Skill according to the host manifest and runs declared MCP
  commands without a shell. WorkBuddy import remains an explicit UI step.
  MCP OAuth and the separate Runtime OAuth are started only when --apply
  --login is explicit. Background channel startup never opens a browser.
  Local iLink tokens are never requested, uploaded, or printed: the channel
  bridge stores them under ~/.attention/channel/ and reports only bounded,
  privacy-safe health checkpoints through the dedicated Runtime credential.

Origin:
  Pass --origin or set ATTENTION_ORIGIN. Non-loopback origins must use HTTPS.
`;

function parseOptions(args: readonly string[]): ParsedOptions {
  const positionals: string[] = [];
  let apply = false;
  let background = false;
  let forceSkill = false;
  let json = false;
  let login = false;
  let origin: string | undefined;
  let probe = false;
  let service = false;
  let skillDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--apply") apply = true;
    else if (argument === "--background") background = true;
    else if (argument === "--force-skill") forceSkill = true;
    else if (argument === "--json") json = true;
    else if (argument === "--login") login = true;
    else if (argument === "--probe") probe = true;
    else if (argument === "--service") service = true;
    else if (argument === "--origin" || argument === "--skill-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--origin") origin = value;
      else skillDirectory = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }

  if (login && !apply) {
    throw new Error("--login is only valid together with --apply.");
  }
  if (forceSkill && !apply) {
    throw new Error("--force-skill is only valid together with --apply.");
  }

  return {
    apply,
    background,
    forceSkill,
    json,
    login,
    origin,
    positionals,
    probe,
    service,
    skillDirectory,
  };
}

function parseHost(value: string | undefined): AgentIntegrationId {
  const parsed = AgentIntegrationIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Choose a host: openclaw, hermes, codex, claude-code, or workbuddy.",
    );
  }
  return parsed.data;
}

function rejectConfigureOnlyOptions(
  options: ParsedOptions,
  command: "integrations" | "doctor",
): void {
  if (
    options.apply ||
    options.background ||
    options.forceSkill ||
    options.login ||
    options.service ||
    options.skillDirectory
  ) {
    throw new Error(
      `${command} does not accept channel or configure-only options.`,
    );
  }
}

function availabilityLabel(value: AgentCapabilityAvailability): string {
  return {
    available: "available",
    available_external: "external host capability",
    contract_only: "contract only / not shipped",
    experimental: "experimental",
    host_managed_unverifiable: "host-managed / not verifiable",
    unsupported: "unsupported",
  }[value];
}

function formatIntegrations(json: boolean): string {
  const integrations = listAgentIntegrations();
  if (json) return JSON.stringify(integrations, null, 2);
  const lines = [
    "Local Agent integrations",
    "",
    "HOST          INTERACTIVE   WECHAT / CHANNEL                INBOUND",
  ];
  for (const integration of integrations) {
    lines.push(
      `${integration.id.padEnd(13)} ${availabilityLabel(integration.interactive).padEnd(13)} ${availabilityLabel(integration.channel).padEnd(31)} ${availabilityLabel(integration.inbound)}`,
    );
  }
  lines.push(
    "",
    "Attention can confirm authenticated MCP use for these profiles, but cannot identify a real WeChat account.",
  );
  return lines.join("\n");
}

function commandLine(command: ReturnType<typeof buildConfigurePlan>["mcpAddCommand"]): string {
  return command ? formatInvocation(command) : "Manual host UI step";
}

function skillInstallDescription(
  plan: ReturnType<typeof buildConfigurePlan>,
): string {
  if (plan.skillInstallCommand) return formatInvocation(plan.skillInstallCommand);
  if (plan.profile.skill.delivery === "host_user_directory") {
    return `validated file copy to ${plan.skillDirectory}`;
  }
  if (plan.profile.skill.delivery === "host_upload_bundle") {
    return `verified bundle download to ${plan.skillDirectory}; import in the host UI`;
  }
  if (plan.profile.skill.delivery === "unpublished_bundle") {
    return "not published for this host";
  }
  return "Manual host UI step";
}

function formatConfigurePlan(
  plan: ReturnType<typeof buildConfigurePlan>,
  json: boolean,
): string {
  if (json) {
    return JSON.stringify(
      {
        boundaries: {
          channel: plan.profile.channel.availability,
          inbound: plan.profile.inbound.availability,
          inbound_detail: plan.inboundBoundary,
          runtime_reporting: plan.profile.runtime_reporting.availability,
          wechat_identity_observable:
            plan.profile.claims.can_confirm_wechat_identity,
        },
        commands: {
          channel_handoff: plan.channelCommands,
          compatibility_checks: plan.compatibilityCheckCommands,
          mcp_add: plan.mcpAddCommand,
          mcp_login: plan.loginCommand,
          mcp_probe: plan.mcpProbeCommand,
          skill_install: plan.skillInstallCommand,
        },
        docs: {
          channel: plan.channelDocsUrl,
          mcp: plan.mcpDocsUrl,
          skill: plan.skillDocsUrl,
        },
        host: plan.hostId,
        mcp_url: plan.mcpUrl,
        skill_directory: plan.skillDirectory,
        skill_document_sha256: plan.skillDocumentSha256,
        skill_bundle_sha256: plan.skillBundleSha256,
        skill_bundle_url: plan.skillBundleUrl,
        download_skill_bundle: plan.downloadSkillBundle,
        skill_source_url: plan.skillSourceUrl,
        stage_skill: plan.stageSkill,
      },
      null,
      2,
    );
  }

  const lines = [
    `${plan.profile.display_name} configuration (dry run)`,
    "",
    `Skill source: ${plan.skillSourceUrl}`,
    `Skill docs:   ${plan.skillDocsUrl}`,
    `Skill SHA-256: ${plan.skillDocumentSha256}`,
  ];
  if (plan.stageSkill) {
    lines.push(
      `${plan.profile.skill.delivery === "host_user_directory" ? "Skill install" : "Skill staging"} directory: ${plan.skillDirectory}`,
    );
  }
  if (plan.downloadSkillBundle && plan.skillBundleUrl) {
    lines.push(
      `Skill bundle: ${plan.skillBundleUrl}`,
      `Bundle SHA-256: ${plan.skillBundleSha256 ?? "missing"}`,
      `Bundle download directory: ${plan.skillDirectory}`,
    );
  }
  lines.push(
    `Skill install: ${skillInstallDescription(plan)}`,
    "",
    `MCP endpoint: ${plan.mcpUrl}`,
    `MCP add:      ${commandLine(plan.mcpAddCommand)}`,
    `MCP OAuth:    ${commandLine(plan.loginCommand)}`,
    `MCP probe:    ${commandLine(plan.mcpProbeCommand)}`,
    `MCP docs:     ${plan.mcpDocsUrl}`,
    ...(plan.compatibilityCheckCommands.length > 0
      ? [
          "Compatibility checks:",
          ...plan.compatibilityCheckCommands.map(
            (command) => `  ${formatInvocation(command)}`,
          ),
        ]
      : []),
    "",
    "WeChat / inbound boundary:",
    `  ${plan.inboundBoundary}`,
  );
  if (plan.channelCommands.length > 0) {
    lines.push(
      plan.profile.channel.mode === "bridge"
        ? "  WeChat inbound via the local attention-channel bridge (run after configure --apply --login):"
        : "  Host-owned channel handoff (shown for reference; configure never executes these):",
      ...plan.channelCommands.map((command) => `    ${formatInvocation(command)}`),
    );
  } else {
    lines.push(
      "  No verified channel CLI is exposed for this host; follow its UI or official docs.",
    );
  }
  if (plan.channelDocsUrl) lines.push(`  Channel docs: ${plan.channelDocsUrl}`);
  lines.push(
    "",
    "Nothing was changed. Re-run with --apply to install/download Skill and configure MCP.",
    "OAuth still requires explicit --apply --login.",
  );
  return lines.join("\n");
}

function formatApplyResults(results: readonly ApplyResult[], json: boolean): string {
  if (json) return JSON.stringify(results, null, 2);
  const icons = {
    applied: "ok",
    failed: "failed",
    manual: "manual",
    skipped: "skipped",
  } as const;
  return results
    .map(
      (result) =>
        `[${icons[result.status]}] ${result.id}: ${result.detail}${
          result.command ? `\n  ${formatInvocation(result.command)}` : ""
        }`,
    )
    .join("\n");
}

function formatDoctor(checks: readonly DiagnosticCheck[], json: boolean): string {
  if (json) return JSON.stringify(checks, null, 2);
  return checks
    .map((check) => `[${check.status}] ${check.title}: ${check.detail}`)
    .join("\n");
}

function defaultOutput(): OutputWriter {
  return {
    error: (value) => process.stderr.write(`${value}\n`),
    log: (value) => process.stdout.write(`${value}\n`),
  };
}

export async function runAttentionCli(
  args: readonly string[],
  dependencies: AttentionCliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? defaultOutput();
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    output.log(HELP.trimEnd());
    return 0;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    output.log(CLI_VERSION);
    return 0;
  }

  try {
    const command = args[0];
    const options = parseOptions(args.slice(1));
    if (command === "integrations") {
      rejectConfigureOnlyOptions(options, "integrations");
      if (options.origin || options.probe) {
        throw new Error("integrations accepts only the optional list and --json.");
      }
      if (
        options.positionals.length > 1 ||
        (options.positionals.length === 1 && options.positionals[0] !== "list")
      ) {
        throw new Error("Usage: attention integrations [list] [--json]");
      }
      output.log(formatIntegrations(options.json));
      return 0;
    }

    if (command === "configure") {
      if (options.probe || options.background || options.service) {
        throw new Error(
          "configure does not accept --probe, --background, or --service; use attention doctor or channel start.",
        );
      }
      if (options.positionals.length !== 1) {
        throw new Error("Usage: attention configure <host> --origin <https-origin>");
      }
      const hostId = parseHost(options.positionals[0]);
      const origin = requireAttentionOrigin(
        options.origin,
        dependencies.environment ?? process.env,
      );
      const plan = buildConfigurePlan({
        hostId,
        origin,
        ...(options.skillDirectory
          ? { skillDirectory: options.skillDirectory }
          : {}),
      });
      if (!options.apply) {
        output.log(formatConfigurePlan(plan, options.json));
        return 0;
      }
      const apply = dependencies.applyConfigure ?? applyConfigurePlan;
      const results = await apply(plan, {
        ...(dependencies.authorizeRuntime
          ? { authorizeRuntime: dependencies.authorizeRuntime }
          : {}),
        forceSkill: options.forceSkill,
        login: options.login,
      });
      output.log(formatApplyResults(results, options.json));
      return results.some((result) => result.status === "failed") ? 1 : 0;
    }

    if (command === "doctor") {
      rejectConfigureOnlyOptions(options, "doctor");
      if (options.positionals.length !== 1) {
        throw new Error("Usage: attention doctor <host> --origin <https-origin>");
      }
      const hostId = parseHost(options.positionals[0]);
      const origin = requireAttentionOrigin(
        options.origin,
        dependencies.environment ?? process.env,
      );
      const plan = buildConfigurePlan({ hostId, origin });
      const doctor = dependencies.runDoctorChecks ?? runDoctor;
      const hostExecutable =
        plan.mcpAddCommand?.executable ??
        plan.loginCommand?.executable ??
        plan.mcpProbeCommand?.executable ??
        plan.skillInstallCommand?.executable ??
        null;
      const checks = await doctor({
        ...(plan.profile.inbound.engine === "attention_channel_bridge"
          ? { bridgePreflight: { hostId } }
          : {}),
        compatibilityInvocations: plan.compatibilityCheckCommands,
        hostId,
        loginInvocation: plan.loginCommand,
        mcpUrl: plan.mcpUrl,
        minimumVersion:
          plan.profile.compatibility.minimum_version ??
          plan.profile.channel.minimum_version ??
          plan.profile.inbound.minimum_version,
        probe: options.probe,
        probeEvidence: plan.profile.mcp.probe_evidence,
        probeInvocation: plan.mcpProbeCommand,
        versionInvocation: hostExecutable
          ? { args: ["--version"], executable: hostExecutable }
          : null,
      });
      output.log(formatDoctor(checks, options.json));
      return doctorExitCode(checks);
    }

    if (command === "channel") {
      if (
        options.apply ||
        options.forceSkill ||
        options.login ||
        options.probe ||
        options.skillDirectory
      ) {
        throw new Error(
          "channel does not accept --apply, --login, --probe, --force-skill, or --skill-dir.",
        );
      }
      const action = options.positionals[0];
      const runChannel = dependencies.runChannel ?? defaultRunChannel;
      if (action === "start") {
        const hostId = options.positionals[1];
        if (!hostId || options.positionals.length > 2) {
          throw new Error(
            "Usage: attention channel start <codex|claude-code>",
          );
        }
        const origin = requireAttentionOrigin(
          options.origin,
          dependencies.environment ?? process.env,
        );
        return await runChannel({
          action: "start",
          background: options.background,
          hostId,
          json: options.json,
          origin,
          service: options.service,
        });
      }
      if (action === "status") {
        if (
          options.positionals.length > 1 ||
          options.background ||
          options.service
        ) {
          throw new Error("Usage: attention channel status [--json]");
        }
        return await runChannel({
          action: "status",
          background: false,
          hostId: null,
          json: options.json,
          service: false,
        });
      }
      if (action === "logout") {
        if (
          options.positionals.length > 1 ||
          options.json ||
          options.background ||
          options.service
        ) {
          throw new Error("Usage: attention channel logout");
        }
        return await runChannel({
          action: "logout",
          background: false,
          hostId: null,
          json: false,
          service: false,
        });
      }
      throw new Error(
        "Usage: attention channel <start <codex|claude-code>|status|logout>",
      );
    }

    throw new Error(`Unknown command: ${String(command)}.`);
  } catch (error) {
    output.error(error instanceof Error ? error.message : "Attention CLI failed.");
    output.error("Run attention --help for usage.");
    return 2;
  }
}

async function defaultRunChannel(input: {
  readonly action: "logout" | "start" | "status";
  readonly background: boolean;
  readonly hostId: string | null;
  readonly json: boolean;
  readonly origin?: string;
  readonly service: boolean;
}): Promise<number> {
  if (input.action === "start" && input.hostId) {
    return await channelStart(input.hostId, {
      background: input.background,
      ...(input.origin ? { origin: input.origin } : {}),
      service: input.service,
    });
  }
  if (input.action === "status") {
    return await channelStatus({ json: input.json });
  }
  return await channelLogout();
}
