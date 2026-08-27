import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  ATTENTION_SKILL_DOCUMENT_SHA256,
  ATTENTION_SKILL_PACKAGE_VERSION,
  ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
  type AgentCapabilityAvailability,
  type AgentCommandTemplate,
  type AgentInstallationProfile,
  type AgentIntegrationId,
  agentInstallationProfiles,
  getAgentInstallationProfile,
} from "@attention/contracts";

import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "./command-runner";
import { formatInvocation, runCommand } from "./command-runner";
import { resolveAttentionPublicUrl } from "./origin";

const MAXIMUM_SKILL_BYTES = 262_144;
const MAXIMUM_SKILL_BUNDLE_BYTES = 10 * 1024 * 1024;

export interface AgentIntegrationSummary {
  readonly channel: AgentCapabilityAvailability;
  readonly displayName: string;
  readonly id: AgentIntegrationId;
  readonly inbound: AgentCapabilityAvailability;
  readonly interactive: AgentCapabilityAvailability;
  readonly mcpObservable: boolean;
  readonly runtimeObservable: boolean;
  readonly wechatIdentityObservable: false;
}

export interface ConfigurePlan {
  readonly channelCommands: readonly CommandInvocation[];
  readonly channelDocsUrl: string | null;
  readonly compatibilityCheckCommands: readonly CommandInvocation[];
  readonly downloadSkillBundle: boolean;
  readonly hostId: AgentIntegrationId;
  readonly inboundBoundary: string;
  readonly loginCommand: CommandInvocation | null;
  readonly mcpAddCommand: CommandInvocation | null;
  readonly mcpDocsUrl: string;
  readonly mcpProbeCommand: CommandInvocation | null;
  readonly mcpUrl: string;
  readonly origin: string;
  readonly profile: AgentInstallationProfile;
  readonly skillDirectory: string;
  readonly skillDocumentSha256: string;
  readonly skillBundleSha256: string | null;
  readonly skillBundleUrl: string | null;
  readonly skillDocsUrl: string;
  readonly skillInstallCommand: CommandInvocation | null;
  readonly skillSourceUrl: string;
  readonly stageSkill: boolean;
}

export interface ApplyResult {
  readonly command: CommandInvocation | null;
  readonly detail: string;
  readonly id: string;
  readonly status: "applied" | "failed" | "manual" | "skipped";
}

export interface ApplyConfigureOptions {
  readonly fetchImpl?: typeof fetch;
  readonly forceSkill?: boolean;
  readonly login: boolean;
  readonly runner?: CommandRunner;
}

export function listAgentIntegrations(): readonly AgentIntegrationSummary[] {
  return agentInstallationProfiles.map((profile) => ({
    channel: profile.channel.availability,
    displayName: profile.display_name,
    id: profile.id,
    inbound: profile.inbound.availability,
    interactive: profile.interactive.availability,
    mcpObservable: profile.claims.can_confirm_mcp,
    runtimeObservable: profile.claims.can_confirm_runtime,
    wechatIdentityObservable: profile.claims.can_confirm_wechat_identity,
  }));
}

export function defaultSkillDirectory(hostId: AgentIntegrationId): string {
  if (hostId === "codex") {
    return join(homedir(), ".agents", "skills", "attention");
  }
  if (hostId === "claude-code") {
    return join(homedir(), ".claude", "skills", "attention");
  }
  if (hostId === "openclaw") {
    return resolve("attention-skill");
  }
  if (hostId === "workbuddy") {
    return join(homedir(), "Downloads");
  }
  if (hostId === "deepseek") {
    return join(homedir(), ".dsh", "skills", "attention");
  }
  return join(homedir(), ".attention", "skills", "attention");
}

function replaceTemplateValue(
  value: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let rendered = value;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{${placeholder}}`, replacement);
  }
  const unresolved = rendered.match(/\{[a-z_]+\}/g);
  if (unresolved) {
    throw new Error(
      `Unsupported command placeholder ${unresolved.join(", ")} in installation manifest.`,
    );
  }
  return rendered;
}

export function renderCommandTemplate(
  template: AgentCommandTemplate | null,
  replacements: Readonly<Record<string, string>>,
): CommandInvocation | null {
  if (!template) return null;
  return {
    args: template.args.map((argument) =>
      replaceTemplateValue(argument, replacements),
    ),
    executable: replaceTemplateValue(template.executable, replacements),
  };
}

function describeInboundBoundary(profile: AgentInstallationProfile): string {
  if (profile.inbound.engine === "attention_channel_bridge") {
    return `${profile.display_name} Skill/MCP is available for interactive use. Inbound WeChat is provided by the local attention-channel bridge: run \`attention channel start ${profile.id} --background\` after \`attention configure ${profile.id} --apply --login\`. The bridge keeps the iLink credential on this device, invokes ${profile.display_name} in a restricted Attention-only profile, and uses a separate optional Runtime OAuth client for privacy-safe health checkpoints and completed-summary delivery.`;
  }
  if (profile.inbound.engine === "codex_sdk_companion") {
    return `${profile.display_name} Skill/MCP is available for interactive use. Inbound WeChat requires the planned Codex SDK companion (${profile.inbound.availability}), which is not shipped in this release.`;
  }
  if (profile.inbound.engine === "claude_channel_preview") {
    const requirements = [
      profile.inbound.minimum_version
        ? `${profile.display_name} >= ${profile.inbound.minimum_version}`
        : null,
      profile.inbound.requires_running_cli ? "a running CLI" : null,
    ].filter((value): value is string => Boolean(value));
    return `${profile.display_name} Skill/MCP is available for interactive use. Native Channels are ${profile.inbound.availability}${requirements.length > 0 ? ` and require ${requirements.join(" and ")}` : ""}; Desktop inbound activation is ${profile.desktop.inbound}.`;
  }
  if (profile.channel.availability === "host_managed_unverifiable") {
    return `${profile.display_name} manages its channel and OAuth inside the host UI. Attention ${profile.claims.can_confirm_mcp ? "can observe authenticated MCP calls" : "cannot confirm MCP use"}, not the local WeChat binding or identity.`;
  }
  if (profile.channel.availability === "unsupported") {
    return `${profile.display_name} Skill/MCP is available for interactive use. This integration does not provide inbound WeChat, channel pairing, or Runtime reporting.`;
  }
  return `The ${profile.channel.owner} host owns its local WeChat gateway. Attention does not receive the iLink credential and ${profile.claims.can_confirm_channel_pairing ? "can confirm a reported pairing" : "cannot confirm pairing until a shipped Runtime reporter provides evidence"}.`;
}

export function buildConfigurePlan(input: {
  readonly hostId: AgentIntegrationId;
  readonly origin: string;
  readonly skillDirectory?: string;
}): ConfigurePlan {
  const profile = getAgentInstallationProfile(input.hostId);
  const skillDirectory = resolve(
    input.skillDirectory ?? defaultSkillDirectory(profile.id),
  );
  const mcpUrl = resolveAttentionPublicUrl(input.origin, profile.mcp.url_template);
  const skillSourceUrl = resolveAttentionPublicUrl(
    input.origin,
    profile.skill.source_path,
  );
  const skillBundleUrl = profile.skill.bundle_path
    ? resolveAttentionPublicUrl(input.origin, profile.skill.bundle_path)
    : null;
  const replacements = {
    attention_origin: input.origin,
    attention_skill_directory: skillDirectory,
    mcp_url: mcpUrl,
    skill_bundle_url: skillBundleUrl ?? "",
    skill_url: skillSourceUrl,
  };
  const stageSkill =
    profile.skill.delivery === "host_import_directory" ||
    profile.skill.delivery === "host_user_directory";

  return {
    channelCommands: profile.channel.setup_command_templates.map((template) => {
      const command = renderCommandTemplate(template, replacements);
      if (!command) throw new Error("Channel command unexpectedly missing.");
      return command;
    }),
    channelDocsUrl: profile.channel.docs_url,
    compatibilityCheckCommands: profile.compatibility.command_checks.map(
      (template) => {
        const command = renderCommandTemplate(template, replacements);
        if (!command) {
          throw new Error("Compatibility command unexpectedly missing.");
        }
        return command;
      },
    ),
    downloadSkillBundle: profile.skill.delivery === "host_upload_bundle",
    hostId: profile.id,
    inboundBoundary: describeInboundBoundary(profile),
    loginCommand: renderCommandTemplate(
      profile.mcp.login_command_template,
      replacements,
    ),
    mcpAddCommand: renderCommandTemplate(
      profile.mcp.add_command_template,
      replacements,
    ),
    mcpDocsUrl: profile.mcp.docs_url,
    mcpProbeCommand: renderCommandTemplate(
      profile.mcp.probe_command_template,
      replacements,
    ),
    mcpUrl,
    origin: input.origin,
    profile,
    skillDirectory,
    skillDocumentSha256: profile.skill.document_sha256,
    skillBundleSha256: profile.skill.bundle_sha256,
    skillBundleUrl,
    skillDocsUrl: profile.skill.docs_url,
    skillInstallCommand: renderCommandTemplate(
      profile.skill.install_command_template,
      replacements,
    ),
    skillSourceUrl,
    stageSkill,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeBundleFilename(sourceUrl: string): string {
  const filename = basename(new URL(sourceUrl).pathname);
  if (!/^[a-z0-9][a-z0-9._-]*\.zip$/iu.test(filename)) {
    throw new Error("Skill bundle URL does not contain a safe .zip filename.");
  }
  return filename;
}

export async function downloadAttentionSkillBundle(input: {
  readonly directory: string;
  readonly expectedSha256: string;
  readonly fetchImpl?: typeof fetch;
  readonly force?: boolean;
  readonly sourceUrl: string;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.sourceUrl, {
    headers: {
      Accept: "application/zip",
      "User-Agent": "attention-cli/0.1",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Skill bundle download failed with HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAXIMUM_SKILL_BUNDLE_BYTES) {
    throw new Error("Skill bundle exceeds WorkBuddy's 10 MiB safety limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_SKILL_BUNDLE_BYTES) {
    throw new Error("Skill bundle exceeds WorkBuddy's 10 MiB safety limit.");
  }
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    throw new Error("Downloaded WorkBuddy Skill bundle is not a ZIP archive.");
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== input.expectedSha256) {
    throw new Error(
      `Skill bundle checksum mismatch (expected ${input.expectedSha256}, received ${actualSha256}).`,
    );
  }

  const target = join(input.directory, safeBundleFilename(input.sourceUrl));
  const kind = await pathKind(target);
  if (kind === "other") {
    throw new Error(`Refusing to replace non-file or symbolic-link target: ${target}`);
  }
  if (kind === "file" && !input.force) {
    const existing = new Uint8Array(await readFile(target));
    if (sha256(existing) === input.expectedSha256) return target;
    throw new Error(
      `Skill bundle already exists at ${target}. Re-run with --force-skill to replace it.`,
    );
  }

  await mkdir(dirname(target), { mode: 0o700, recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

interface AttentionSkillContractExpectation {
  readonly packageVersion: string;
  readonly toolContractVersion: string;
}

function skillVersionField(
  document: string,
  label: "Skill version" | "Tool contract version",
): string | null {
  const pattern = new RegExp(
    `^${label}:\\s*` + "`([^`\\n]+)`" + "\\s*$",
    "gmu",
  );
  const values = [...document.matchAll(pattern)].map((match) => match[1]);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function validateSkillDocument(
  value: string,
  expectation: AttentionSkillContractExpectation,
): void {
  const normalized = value.replaceAll("\r\n", "\n");
  const frontmatterEnd = normalized.indexOf("\n---\n", 4);
  const frontmatter =
    normalized.startsWith("---\n") && frontmatterEnd >= 0
      ? normalized.slice(4, frontmatterEnd)
      : null;
  const attentionNames = frontmatter?.match(/^name:\s*attention\s*$/gmu) ?? [];
  if (
    frontmatter === null ||
    attentionNames.length !== 1 ||
    !/^# Attention\s*$/mu.test(normalized.slice(frontmatterEnd + 5))
  ) {
    throw new Error(
      "Downloaded file is not a valid Attention SKILL.md document.",
    );
  }

  const packageVersion = skillVersionField(normalized, "Skill version");
  if (packageVersion === null) {
    throw new Error(
      "Downloaded Attention SKILL.md must declare exactly one Skill version.",
    );
  }
  if (packageVersion !== expectation.packageVersion) {
    throw new Error(
      `Skill version mismatch: expected ${expectation.packageVersion}, received ${packageVersion}.`,
    );
  }

  const toolContractVersion = skillVersionField(
    normalized,
    "Tool contract version",
  );
  if (toolContractVersion === null) {
    throw new Error(
      "Downloaded Attention SKILL.md must declare exactly one Tool contract version.",
    );
  }
  if (toolContractVersion !== expectation.toolContractVersion) {
    throw new Error(
      `Tool contract version mismatch: expected ${expectation.toolContractVersion}, received ${toolContractVersion}.`,
    );
  }
}

async function fetchAttentionSkillDocument(input: {
  readonly expectedDocumentSha256: string;
  readonly expectedPackageVersion: string;
  readonly expectedToolContractVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly sourceUrl: string;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.sourceUrl, {
    headers: {
      Accept: "text/markdown, text/plain;q=0.9",
      "User-Agent": "attention-cli/0.1",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Skill download failed with HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAXIMUM_SKILL_BYTES) {
    throw new Error("Skill document exceeds the 256 KiB safety limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_SKILL_BYTES) {
    throw new Error("Skill document exceeds the 256 KiB safety limit.");
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== input.expectedDocumentSha256) {
    throw new Error(
      `Skill document checksum mismatch (expected ${input.expectedDocumentSha256}, received ${actualSha256}).`,
    );
  }
  const document = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  validateSkillDocument(document, {
    packageVersion: input.expectedPackageVersion,
    toolContractVersion: input.expectedToolContractVersion,
  });
  return document;
}

async function pathKind(path: string): Promise<"missing" | "file" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "other";
    return stat.isFile() ? "file" : "other";
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return "missing";
    }
    throw error;
  }
}

export async function stageAttentionSkill(input: {
  readonly directory: string;
  readonly expectedDocumentSha256?: string;
  readonly expectedPackageVersion?: string;
  readonly expectedToolContractVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly force?: boolean;
  readonly sourceUrl: string;
}): Promise<string> {
  const document = await fetchAttentionSkillDocument({
    expectedDocumentSha256:
      input.expectedDocumentSha256 ?? ATTENTION_SKILL_DOCUMENT_SHA256,
    expectedPackageVersion:
      input.expectedPackageVersion ?? ATTENTION_SKILL_PACKAGE_VERSION,
    expectedToolContractVersion:
      input.expectedToolContractVersion ??
      ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    sourceUrl: input.sourceUrl,
  });

  const target = join(input.directory, "SKILL.md");
  const kind = await pathKind(target);
  if (kind === "other") {
    throw new Error(`Refusing to replace non-file or symbolic-link target: ${target}`);
  }
  if (kind === "file" && !input.force) {
    const existing = await readFile(target, "utf8");
    if (existing === document) return target;
    throw new Error(
      `Skill already exists at ${target}. Re-run with --force-skill to replace it.`,
    );
  }

  await mkdir(dirname(target), { mode: 0o700, recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, document, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

function resultDetail(result: CommandResult): string {
  if (result.timedOut) return "Command timed out.";
  return result.stderr || result.stdout || `Exit code ${String(result.exitCode)}.`;
}

async function applyCommand(
  id: string,
  command: CommandInvocation | null,
  runner: CommandRunner,
): Promise<ApplyResult> {
  if (!command) {
    return {
      command: null,
      detail: "This host requires a manual UI step.",
      id,
      status: "manual",
    };
  }
  const result = await runner(command, { timeoutMs: 45_000 });
  if (result.exitCode !== 0) {
    return {
      command,
      detail: resultDetail(result),
      id,
      status: "failed",
    };
  }
  return {
    command,
    detail: result.stdout || result.stderr || "Done.",
    id,
    status: "applied",
  };
}

export async function applyConfigurePlan(
  plan: ConfigurePlan,
  options: ApplyConfigureOptions,
): Promise<readonly ApplyResult[]> {
  const results: ApplyResult[] = [];
  const runner = options.runner ?? runCommand;

  for (const [index, command] of plan.compatibilityCheckCommands.entries()) {
    const compatibility = await applyCommand(
      `compatibility_check_${String(index + 1)}`,
      command,
      runner,
    );
    results.push(compatibility);
    if (compatibility.status === "failed") return results;
  }

  if (plan.profile.skill.delivery === "remote_url") {
    try {
      await fetchAttentionSkillDocument({
        expectedDocumentSha256: plan.skillDocumentSha256,
        expectedPackageVersion: plan.profile.skill.version,
        expectedToolContractVersion:
          plan.profile.skill.tool_contract_version,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        sourceUrl: plan.skillSourceUrl,
      });
      results.push({
        command: null,
        detail: `Validated Attention Skill ${plan.profile.skill.version} (tool contract ${plan.profile.skill.tool_contract_version}).`,
        id: "validate_skill",
        status: "applied",
      });
    } catch (error) {
      results.push({
        command: null,
        detail:
          error instanceof Error ? error.message : "Skill validation failed.",
        id: "validate_skill",
        status: "failed",
      });
      return results;
    }
  }

  if (plan.downloadSkillBundle) {
    if (!plan.skillBundleUrl || !plan.skillBundleSha256) {
      return [
        {
          command: null,
          detail: "The installation manifest is missing WorkBuddy bundle metadata.",
          id: "download_skill_bundle",
          status: "failed",
        },
      ];
    }
    try {
      const target = await downloadAttentionSkillBundle({
        directory: plan.skillDirectory,
        expectedSha256: plan.skillBundleSha256,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        force: options.forceSkill ?? false,
        sourceUrl: plan.skillBundleUrl,
      });
      results.push({
        command: null,
        detail: `Downloaded and verified ${target}.`,
        id: "download_skill_bundle",
        status: "applied",
      });
    } catch (error) {
      results.push({
        command: null,
        detail:
          error instanceof Error
            ? error.message
            : "Skill bundle download failed.",
        id: "download_skill_bundle",
        status: "failed",
      });
      return results;
    }
  }

  if (plan.stageSkill) {
    try {
      const target = await stageAttentionSkill({
        directory: plan.skillDirectory,
        expectedDocumentSha256: plan.skillDocumentSha256,
        expectedPackageVersion: plan.profile.skill.version,
        expectedToolContractVersion:
          plan.profile.skill.tool_contract_version,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        force: options.forceSkill ?? false,
        sourceUrl: plan.skillSourceUrl,
      });
      results.push({
        command: null,
        detail:
          plan.profile.skill.delivery === "host_user_directory"
            ? `Installed ${target}.`
            : `Staged ${target}.`,
        id:
          plan.profile.skill.delivery === "host_user_directory"
            ? "install_skill"
            : "stage_skill",
        status: "applied",
      });
    } catch (error) {
      results.push({
        command: null,
        detail: error instanceof Error ? error.message : "Skill staging failed.",
        id:
          plan.profile.skill.delivery === "host_user_directory"
            ? "install_skill"
            : "stage_skill",
        status: "failed",
      });
      return results;
    }
  }

  if (
    plan.profile.skill.delivery !== "host_user_directory" &&
    plan.profile.skill.delivery !== "host_upload_bundle"
  ) {
    const skill =
      plan.profile.skill.delivery === "unpublished_bundle"
        ? {
            command: null,
            detail:
              "Attention has not published a WorkBuddy upload bundle. The standalone SKILL.md is reference material, not an upload bundle.",
            id: "install_skill",
            status: "manual" as const,
          }
        : await applyCommand(
            "install_skill",
            plan.skillInstallCommand,
            runner,
          );
    results.push(skill);
    if (skill.status === "failed") return results;
  }

  if (plan.profile.skill.delivery === "host_upload_bundle") {
    results.push({
      command: null,
      detail:
        "Upload the downloaded ZIP in WorkBuddy's Skill UI. Attention downloaded it but did not import or enable it.",
      id: "install_skill",
      status: "manual",
    });
  }

  const mcpSetupStep = plan.profile.install_steps.find(
    (step) => step.id === "configure_mcp",
  );
  if (mcpSetupStep?.executor !== "attention_installer") {
    results.push({
      command: plan.mcpAddCommand,
      detail:
        plan.profile.mcp.setup_mode === "interactive_oauth" &&
        plan.mcpAddCommand
          ? `Run ${formatInvocation(plan.mcpAddCommand)} in an interactive terminal. This host performs OAuth and tool selection during the add command, so Attention will not execute it with stdin disabled.`
          : "Add the MCP endpoint and complete OAuth in the host's manual UI.",
      id: "configure_mcp",
      status: "manual",
    });
    return results;
  }

  const mcp = await applyCommand("configure_mcp", plan.mcpAddCommand, runner);
  results.push(mcp);
  if (mcp.status === "failed") return results;

  if (plan.profile.mcp.auth === "bearer_api_key") {
    results.push({
      command: null,
      detail:
        "Set ATTENTION_API_KEY and ATTENTION_MCP_URL in the environment inherited by DSH, then restart the selected profile.",
      id: "authorize_mcp",
      status: "manual",
    });
    return results;
  }

  if (options.login) {
    const login = await applyCommand("authorize_mcp", plan.loginCommand, runner);
    results.push(login);
    if (login.status === "failed") return results;
  } else {
    results.push({
      command: plan.loginCommand,
      detail: plan.loginCommand
        ? `OAuth was not started. Run ${formatInvocation(plan.loginCommand)} or re-run with --apply --login.`
        : "Complete OAuth in the host UI.",
      id: "authorize_mcp",
      status: "manual",
    });
  }

  return results;
}
