import {
  AGENT_INTEGRATION_IDS,
  ATTENTION_INSTALL_GUIDE_PUBLIC_PATH,
  agentInstallationProfiles,
  type AgentCommandTemplate,
  type AgentIntegrationId,
  type AgentInstallationProfile,
} from "@attention/contracts";

export interface AgentConnectionCommand {
  kind: "download_and_verify" | "host_configuration" | "configuration_probe";
  label: string;
  platform: "all" | "posix" | "powershell";
  value: string;
}

/**
 * Honest, setup-only channel guidance. The bridge runs on the user's device
 * and does not report to Attention, so this projection must never expose a
 * connection state — only commands, prerequisites, and boundaries.
 */
export interface AgentConnectionChannelSetup {
  command: string | null;
  detail: string;
  prerequisites: readonly string[];
}

export interface AgentConnectionChecklistStep {
  detail: string;
  title: string;
  value: string | null;
}

export interface AgentConnectionSource {
  label: string;
  url: string;
}

export interface AgentConnectionSkillPath {
  label: string;
  value: string;
}

export interface AgentConnectionProjection {
  acceptance: {
    detail: string;
    toolName: string;
  };
  channelSetup: AgentConnectionChannelSetup | null;
  commands: readonly AgentConnectionCommand[];
  displayName: string;
  id: AgentIntegrationId;
  mcpUrl: string;
  minimumVersion: string | null;
  manualChecklist: readonly AgentConnectionChecklistStep[];
  skillDownloadFilename: string | null;
  skillSha256: string | null;
  skillLabel: string;
  skillPathLabel: string | null;
  skillPaths: readonly AgentConnectionSkillPath[];
  skillUrl: string | null;
  sources: readonly AgentConnectionSource[];
  status: {
    detail: string;
    label: string;
    tone: "available" | "external" | "experimental";
  };
}

const HOST_COPY: Record<
  AgentIntegrationId,
  { statusDetail: string; statusLabel: string; tone: "available" | "external" }
> = {
  "claude-code": {
    statusDetail:
      "Claude Desktop 的 Code tab 与 CLI 共享 Skill、MCP 和 OAuth 配置；普通 Desktop Chat 不共用这套配置。",
    statusLabel: "Desktop Code / CLI 可配置",
    tone: "available",
  },
  codex: {
    statusDetail: "Codex Desktop、CLI 与 IDE 可使用同一套 Skill 和 MCP 配置。",
    statusLabel: "Desktop / CLI 可配置",
    tone: "available",
  },
  hermes: {
    statusDetail:
      "Hermes 可从公开地址安装 Skill；添加 MCP 时会在终端内完成 OAuth 与工具选择。",
    statusLabel: "需交互配置",
    tone: "available",
  },
  openclaw: {
    statusDetail:
      "OpenClaw 可加载 Attention Skill，并通过 OAuth 连接远程 MCP；当前宿主版本还需要 Node.js 22.16.0 或更高版本。",
    statusLabel: "可直接配置",
    tone: "available",
  },
  workbuddy: {
    statusDetail:
      "下载 Attention Skill bundle 后，在 WorkBuddy 宿主界面上传，并手动添加 MCP。",
    statusLabel: "需在宿主界面配置",
    tone: "external",
  },
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./\\:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(
  template: AgentCommandTemplate,
  values: Record<string, string>,
): string {
  const tokens = [template.executable, ...template.args].map((token) => {
    let resolved = token;
    for (const [placeholder, value] of Object.entries(values)) {
      resolved = resolved.replaceAll(placeholder, value);
    }
    return resolved;
  });
  return tokens.map(shellQuote).join(" ");
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sourceFreeSkillUrl(
  origin: string,
  profile: AgentInstallationProfile,
): string {
  const url = new URL(profile.skill.source_path, `${origin}/`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported Skill URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

function posixTargetExpression(value: string): string {
  if (value.startsWith("~/")) {
    return `"$HOME/${value.slice(2).replaceAll('"', '\\"')}"`;
  }
  return shellQuote(value);
}

/**
 * Downloads data only, verifies the exact manifest digest, and atomically
 * moves the verified bytes into the host's Skill directory. It never pipes
 * remote content into an interpreter and preserves an existing Skill if the
 * request or digest check fails.
 */
function posixDownloadAndVerifyCommand({
  sha256,
  target,
  url,
}: {
  sha256: string;
  target: string;
  url: string;
}): string {
  return [
    "(",
    "  set -eu",
    `  attention_skill_url=${shellQuote(url)}`,
    `  attention_skill_target=${posixTargetExpression(target)}`,
    `  attention_skill_sha256=${shellQuote(sha256)}`,
    '  attention_skill_dir=$(dirname "$attention_skill_target")',
    '  mkdir -p "$attention_skill_dir"',
    '  attention_skill_tmp=$(mktemp "$attention_skill_dir/.SKILL.md.XXXXXX")',
    "  trap 'rm -f \"$attention_skill_tmp\"' EXIT HUP INT TERM",
    '  curl --fail --show-error --silent --location --output "$attention_skill_tmp" -- "$attention_skill_url"',
    '  if command -v sha256sum >/dev/null 2>&1; then',
    '    attention_skill_actual=$(sha256sum "$attention_skill_tmp" | awk \'{print $1}\')',
    "  else",
    '    attention_skill_actual=$(shasum -a 256 "$attention_skill_tmp" | awk \'{print $1}\')',
    "  fi",
    '  [ "$attention_skill_actual" = "$attention_skill_sha256" ]',
    '  chmod 0644 "$attention_skill_tmp"',
    '  mv -f "$attention_skill_tmp" "$attention_skill_target"',
    "  trap - EXIT HUP INT TERM",
    ")",
  ].join("\n");
}

function powershellDownloadAndVerifyCommand({
  sha256,
  target,
  url,
}: {
  sha256: string;
  target: string;
  url: string;
}): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$attentionSkillUrl = ${powershellQuote(url)}`,
    `$attentionSkillTarget = [Environment]::ExpandEnvironmentVariables(${powershellQuote(target)})`,
    `$attentionSkillSha256 = ${powershellQuote(sha256)}`,
    "$attentionSkillDirectory = Split-Path -Parent $attentionSkillTarget",
    "New-Item -ItemType Directory -Force -Path $attentionSkillDirectory | Out-Null",
    "$attentionSkillTemp = Join-Path $attentionSkillDirectory ('.SKILL.md.' + [Guid]::NewGuid().ToString('N') + '.tmp')",
    "try {",
    "  Invoke-WebRequest -UseBasicParsing -Uri $attentionSkillUrl -OutFile $attentionSkillTemp",
    "  $attentionSkillActual = (Get-FileHash -Algorithm SHA256 -LiteralPath $attentionSkillTemp).Hash.ToLowerInvariant()",
    "  if ($attentionSkillActual -ne $attentionSkillSha256) { throw \"Attention Skill SHA-256 mismatch\" }",
    "  Move-Item -Force -LiteralPath $attentionSkillTemp -Destination $attentionSkillTarget",
    "} finally {",
    "  if (Test-Path -LiteralPath $attentionSkillTemp) { Remove-Item -Force -LiteralPath $attentionSkillTemp }",
    "}",
  ].join("\n");
}

function commandLabel(template: AgentCommandTemplate): string {
  const command = [template.executable, ...template.args].join(" ");
  if (/skills install/u.test(command)) return "安装 Skill";
  if (/mcp add/u.test(command)) return "添加 MCP";
  if (/mcp login/u.test(command)) return "登录授权";
  if (/mcp (doctor|test|get)/u.test(command)) return "诊断 MCP";
  return "宿主命令";
}

function probeCommandLabel(
  evidence: AgentInstallationProfile["mcp"]["probe_evidence"],
): string {
  if (evidence === "config_only") return "查看 MCP 配置";
  if (evidence === "live_tools") return "验证 MCP 工具";
  return "检查 MCP 连接";
}

function profileStatus(
  profile: AgentInstallationProfile,
): AgentConnectionProjection["status"] {
  return {
    detail: HOST_COPY[profile.id].statusDetail,
    label: HOST_COPY[profile.id].statusLabel,
    tone: HOST_COPY[profile.id].tone,
  };
}

function profileChannelSetup(
  profile: AgentInstallationProfile,
  commandValues: Record<string, string>,
): AgentConnectionChannelSetup | null {
  if (
    profile.channel.mode === "bridge" &&
    profile.inbound.engine === "attention_channel_bridge"
  ) {
    const template = profile.channel.setup_command_templates[0];
    return {
      command: template ? shellCommand(template, commandValues) : null,
      detail: `本机运行的 attention-channel 桥代替 Attention 接收微信消息，并以受限配置调用 ${profile.display_name}（仅 Attention MCP，禁用 shell、代码执行、文件写入和其他 MCP）。iLink 凭据只保存在你的设备上；桥不向 Attention 上报，此页不展示连接状态。`,
      prerequisites: [
        "手机微信 iOS ≥ 8.0.70 或 Android ≥ 8.0.69，并已启用 ClawBot（龙虾）插件",
        `已完成 attention configure ${profile.id} --apply --login（Skill、MCP、OAuth）`,
        `本机已安装 ${profile.id === "codex" ? "codex" : "claude"} CLI`,
      ],
    };
  }
  if (profile.channel.availability === "available_external") {
    return {
      command: null,
      detail: `${profile.display_name} 通过宿主自己的微信渠道完成连接（见下方宿主命令与官方文档）；Attention 只提供 Skill 与 MCP，不接收渠道凭据。`,
      prerequisites: [],
    };
  }
  if (profile.channel.availability === "host_managed_unverifiable") {
    return {
      command: null,
      detail: `${profile.display_name} 在宿主界面内管理微信助理；Attention 无法验证其连接状态，也不提供连接面板。`,
      prerequisites: [],
    };
  }
  return null;
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function profileSources(
  profile: AgentInstallationProfile,
): readonly AgentConnectionSource[] {
  const candidates = [
    ["MCP", profile.mcp.docs_url],
    ["Skill", profile.skill.docs_url],
    ["Skill 源码", profile.skill.package_ref],
  ] as const;
  const seen = new Set<string>();
  return candidates.flatMap(([label, url]) => {
    if (!url || seen.has(url) || !isPublicHttpUrl(url)) return [];
    seen.add(url);
    return [{ label, url }];
  });
}

function normalizeOrigin(value: string): string {
  return value.replace(/\/$/u, "");
}

function joinSkillEntrypoint(directory: string, entrypoint: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]$/u, "")}${separator}${entrypoint}`;
}

function profileSkillPaths(
  profile: AgentInstallationProfile,
): readonly AgentConnectionSkillPath[] {
  const localPath = profile.skill.local_path;
  if (!localPath) return [];
  const candidates = [
    localPath.posix_directory
      ? {
          label: "macOS / Linux",
          value: joinSkillEntrypoint(
            localPath.posix_directory,
            localPath.entrypoint,
          ),
        }
      : null,
    localPath.windows_directory
      ? {
          label: "Windows",
          value: joinSkillEntrypoint(
            localPath.windows_directory,
            localPath.entrypoint,
          ),
        }
      : null,
  ].filter((value): value is AgentConnectionSkillPath => value !== null);
  if (
    candidates.length === 2 &&
    candidates[0]?.value === candidates[1]?.value
  ) {
    const [first] = candidates;
    if (first) return [{ label: "所有平台", value: first.value }];
  }
  return candidates;
}

export function projectAgentConnections({
  mcpUrl,
  origin,
}: {
  mcpUrl: string;
  origin: string;
}): readonly AgentConnectionProjection[] {
  const normalizedOrigin = normalizeOrigin(origin);
  const profileById = new Map(
    agentInstallationProfiles.map((profile) => [profile.id, profile]),
  );

  return AGENT_INTEGRATION_IDS.map((id) => {
    const profile = profileById.get(id);
    if (!profile) throw new Error(`Missing Agent installation profile: ${id}`);
    const documentUrl = sourceFreeSkillUrl(normalizedOrigin, profile);
    const profileSkillUrl = profile.skill.bundle_path
      ? new URL(profile.skill.bundle_path, `${normalizedOrigin}/`).toString()
      : documentUrl;
    const commandValues = {
      "{attention_origin}": normalizedOrigin,
      "{attention_skill_directory}":
        profile.skill.local_path?.posix_directory ??
        profile.skill.local_path?.windows_directory ??
        "",
      "{mcp_url}": mcpUrl,
      "{skill_bundle_url}": profileSkillUrl,
      "{skill_url}": documentUrl,
    };
    const localPath = profile.skill.local_path;
    const sourceFreeCommands: readonly AgentConnectionCommand[] =
      profile.skill.delivery === "host_user_directory" ||
      profile.skill.delivery === "host_import_directory"
        ? [
            ...(localPath?.posix_directory
              ? [
                  {
                    kind: "download_and_verify" as const,
                    label: "下载并校验 Skill（macOS / Linux）",
                    platform: "posix" as const,
                    value: posixDownloadAndVerifyCommand({
                      sha256: profile.skill.document_sha256,
                      target: joinSkillEntrypoint(
                        localPath.posix_directory,
                        localPath.entrypoint,
                      ),
                      url: documentUrl,
                    }),
                  },
                ]
              : []),
            ...(localPath?.windows_directory
              ? [
                  {
                    kind: "download_and_verify" as const,
                    label: "下载并校验 Skill（Windows PowerShell）",
                    platform: "powershell" as const,
                    value: powershellDownloadAndVerifyCommand({
                      sha256: profile.skill.document_sha256,
                      target: joinSkillEntrypoint(
                        localPath.windows_directory,
                        localPath.entrypoint,
                      ),
                      url: documentUrl,
                    }),
                  },
                ]
              : []),
          ]
        : [];
    const skillInstallTemplate = profile.skill.install_command_template;
    const skillCommands: readonly AgentConnectionCommand[] = skillInstallTemplate
      ? profile.skill.local_path?.posix_directory &&
        profile.skill.local_path.windows_directory
        ? [
            {
              kind: "host_configuration" as const,
              label: `${commandLabel(skillInstallTemplate)}（macOS / Linux）`,
              platform: "posix" as const,
              value: shellCommand(skillInstallTemplate, {
                ...commandValues,
                "{attention_skill_directory}":
                  profile.skill.local_path.posix_directory,
              }),
            },
            {
              kind: "host_configuration" as const,
              label: `${commandLabel(skillInstallTemplate)}（Windows）`,
              platform: "powershell" as const,
              value: shellCommand(skillInstallTemplate, {
                ...commandValues,
                "{attention_skill_directory}":
                  profile.skill.local_path.windows_directory,
              }),
            },
          ]
        : [
            {
              kind: "host_configuration" as const,
              label: commandLabel(skillInstallTemplate),
              platform: "all" as const,
              value: shellCommand(skillInstallTemplate, commandValues),
            },
          ]
      : [];
    const mcpTemplates = [
      profile.mcp.add_command_template,
      profile.mcp.setup_mode === "interactive_oauth"
        ? null
        : profile.mcp.login_command_template,
      profile.mcp.probe_command_template,
    ].filter((template): template is AgentCommandTemplate => template !== null);
    const mcpCommands: readonly AgentConnectionCommand[] = mcpTemplates.map(
      (template) => ({
        kind:
          template === profile.mcp.probe_command_template
            ? ("configuration_probe" as const)
            : ("host_configuration" as const),
        label:
          template === profile.mcp.probe_command_template
            ? probeCommandLabel(profile.mcp.probe_evidence)
            : profile.mcp.setup_mode === "interactive_oauth" &&
          template === profile.mcp.add_command_template
            ? "添加并授权 MCP"
            : commandLabel(template),
        platform: "all" as const,
        value: shellCommand(template, commandValues),
      }),
    );

    const manualChecklist: readonly AgentConnectionChecklistStep[] =
      profile.skill.delivery === "host_upload_bundle"
        ? [
            {
              detail: "把官方发布的 ZIP 保存到本机；不要解压后再上传。",
              title: "下载 Skill ZIP",
              value: profileSkillUrl,
            },
            {
              detail: "使用系统文件校验工具核对下载文件，必须与清单完全一致。",
              title: "核对 SHA-256",
              value: profile.skill.bundle_sha256,
            },
            {
              detail: "在 WorkBuddy 中打开 Add Skill → Upload Skill，选择刚刚下载并校验的 ZIP。",
              title: "上传 Skill",
              value: null,
            },
            {
              detail: "在 WorkBuddy 的 MCP 设置中添加地址并完成浏览器 OAuth。",
              title: "添加 MCP 并授权",
              value: mcpUrl,
            },
          ]
        : [];

    return {
      acceptance: {
        detail: `在 ${profile.display_name} 中要求 Agent 调用 ${profile.acceptance.tool_name}；只有成功返回当前 Attention 账号信息，才表示 Skill、MCP 与 OAuth 均已可用。查看本地配置不算验收。`,
        toolName: profile.acceptance.tool_name,
      },
      channelSetup: profileChannelSetup(profile, commandValues),
      commands: [...sourceFreeCommands, ...skillCommands, ...mcpCommands],
      displayName: profile.display_name,
      id,
      mcpUrl,
      minimumVersion: profile.compatibility.minimum_version,
      manualChecklist,
      skillDownloadFilename:
        profile.skill.delivery === "host_upload_bundle"
          ? profile.skill.bundle_path?.split("/").at(-1) ?? null
          : profile.skill.delivery === "remote_url"
            ? null
            : "SKILL.md",
      skillSha256:
        profile.skill.delivery === "host_upload_bundle"
          ? profile.skill.bundle_sha256
          : profile.skill.document_sha256,
      skillLabel:
        profile.skill.delivery === "host_upload_bundle"
          ? "WorkBuddy Skill bundle"
          : "Skill 文件",
      skillPathLabel:
        profile.skill.local_path?.purpose === "staging_source"
          ? "下载后先保存到"
          : profile.skill.local_path
            ? "下载后保存到"
            : null,
      skillPaths: profileSkillPaths(profile),
      skillUrl:
        profile.skill.delivery === "unpublished_bundle"
          ? null
          : profileSkillUrl,
      sources: [
        ...profileSources(profile),
        {
          label: "Attention 安装指南",
          url: `${normalizedOrigin}${ATTENTION_INSTALL_GUIDE_PUBLIC_PATH}`,
        },
      ],
      status: profileStatus(profile),
    };
  });
}
