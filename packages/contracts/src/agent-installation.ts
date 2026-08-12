import { z } from "zod";

import {
  AGENT_INTEGRATION_IDS,
  AgentCapabilityAvailabilitySchema,
  type AgentIntegration,
  AgentIntegrationIdSchema,
  agentIntegrationManifest,
} from "./agent-integration";
import { CHANNEL_RUNTIME_SCOPES } from "./channel-runtime";

/**
 * Schema 2 separates interactive, channel, Runtime, inbound, Desktop, and
 * observable-claim capabilities. The public `/v1/` path is the first product
 * release catalog, not the JSON schema major version.
 */
export const AGENT_INSTALLATION_MANIFEST_SCHEMA_VERSION = "2.3.0" as const;
export const ATTENTION_SKILL_PACKAGE_VERSION = "1.6.0" as const;
export const ATTENTION_SKILL_TOOL_CONTRACT_VERSION = "1.4.0" as const;

export const ATTENTION_SKILL_PUBLIC_PATH =
  "/skills/attention/SKILL.md" as const;
export const ATTENTION_SKILL_DOCUMENT_SHA256 =
  "03f030b23ebad68ffda5676e7658a42a51f0ae8d70b5f58a0820f70938d431fe" as const;
export const ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH =
  "/skills/attention/bundles/attention-workbuddy-1.6.0.zip" as const;
export const ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256 =
  "42a01d4b81bd1edfb943e7ea5ab2552e71f560fd4559ba04f9633fa1cb4b47d0" as const;
export const ATTENTION_WORKBUDDY_SKILL_BUNDLE_SKILL_PATH =
  "SKILL.md" as const;
export const ATTENTION_INSTALL_GUIDE_PUBLIC_PATH =
  "/skills/attention/INSTALL.md" as const;
export const ATTENTION_MCP_URL_TEMPLATE = "{attention_origin}/mcp" as const;
export const ATTENTION_INSTALL_ACCEPTANCE_TOOL =
  "attention_get_my_account" as const;
export const ATTENTION_RUNTIME_URL_TEMPLATE =
  "{attention_origin}/api/runtime" as const;
export const ATTENTION_RESTRICTED_PROFILE_PUBLIC_PATH =
  "/skills/attention/installations/v1/templates/restricted-profile.json" as const;

export const AGENT_COMMAND_TEMPLATE_PLACEHOLDERS = [
  "{attention_origin}",
  "{mcp_url}",
  "{skill_url}",
  "{skill_bundle_url}",
  "{attention_skill_directory}",
] as const;

export const AgentCommandTemplateSchema = z
  .object({
    args: z.array(z.string().min(1)),
    executable: z.string().min(1),
  })
  .strict();
export type AgentCommandTemplate = z.infer<
  typeof AgentCommandTemplateSchema
>;

export const AgentInstallationStepIdSchema = z.enum([
  "detect_host",
  "install_skill",
  "configure_mcp",
  "authorize_mcp",
  "configure_restricted_profile",
  "authorize_runtime",
  "register_runtime",
  "connect_channel",
  "start_inbound",
  "verify_pairing",
]);
export type AgentInstallationStepId = z.infer<
  typeof AgentInstallationStepIdSchema
>;

export const AgentInstallationStepSchema = z
  .object({
    availability: AgentCapabilityAvailabilitySchema,
    credential_target: z.enum([
      "none",
      "mcp_oauth",
      "runtime_oauth",
      "local_channel",
    ]),
    executor: z.enum(["attention_installer", "host", "user"]),
    id: AgentInstallationStepIdSchema,
    requires_browser: z.boolean(),
  })
  .strict();
export type AgentInstallationStep = z.infer<
  typeof AgentInstallationStepSchema
>;

const CompatibilitySchema = z
  .object({
    command_checks: z.array(AgentCommandTemplateSchema),
    minimum_version: z.string().min(1).nullable(),
    policy: z.enum(["pinned", "verify_at_install"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.minimum_version === null) !== (value.policy === "verify_at_install")) {
      context.addIssue({
        code: "custom",
        message:
          "an unpinned minimum version must be verified by the installer",
        path: ["minimum_version"],
      });
    }
    if (
      (value.policy === "verify_at_install") !==
      (value.command_checks.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "verify_at_install requires explicit non-destructive command checks; pinned profiles must not duplicate them",
        path: ["command_checks"],
      });
    }
  });

const RestrictedProfileSchema = z
  .object({
    allowed_mcp_servers: z.array(z.literal("attention")),
    denied_capabilities: z.array(
      z.enum([
        "arbitrary_mcp",
        "browser_automation",
        "code_execution",
        "filesystem_write",
        "shell",
      ]),
    ),
    required: z.boolean(),
    template_path: z.literal(ATTENTION_RESTRICTED_PROFILE_PUBLIC_PATH).nullable(),
  })
  .strict();

const InboundAlternativeSchema = z
  .object({
    availability: AgentCapabilityAvailabilitySchema,
    engine: z.literal("claude_agent_sdk_byo_key"),
    requires_byo_api_key: z.literal(true),
  })
  .strict();

const AgentSkillLocalPathSchema = z
  .object({
    entrypoint: z.literal("SKILL.md"),
    posix_directory: z.string().min(1).max(256).nullable(),
    purpose: z.enum(["install_target", "staging_source"]),
    windows_directory: z.string().min(1).max(256).nullable(),
  })
  .strict();

export const AgentInstallationProfileSchema = z
  .object({
    acceptance: z
      .object({
        config_probe_is_acceptance: z.literal(false),
        requirement: z.literal("successful_tool_result"),
        tool_name: z.literal(ATTENTION_INSTALL_ACCEPTANCE_TOOL),
      })
      .strict(),
    channel: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
        credentials: z.literal("local_device_only"),
        docs_url: z.string().url().nullable(),
        hosted_by_attention: z.literal(false),
        minimum_version: z.string().min(1).nullable(),
        mode: z.enum(["native", "bridge"]),
        owner: z.enum([
          "openclaw",
          "hermes",
          "attention-channel",
          "workbuddy",
        ]),
        package_ref: z.string().min(1).nullable(),
        setup: z.enum(["host_cli_qr", "host_ui_qr", "attention_cli_qr"]),
        setup_command_templates: z.array(AgentCommandTemplateSchema),
        status_evidence: z.enum([
          "host_cli_probe",
          "host_ui_only",
          "running_cli_only",
          "none",
        ]),
      })
      .strict(),
    claims: z
      .object({
        can_confirm_channel_pairing: z.boolean(),
        can_confirm_mcp: z.boolean(),
        can_confirm_runtime: z.boolean(),
        can_confirm_wechat_identity: z.literal(false),
      })
      .strict(),
    compatibility: CompatibilitySchema,
    desktop: z
      .object({
        inbound: AgentCapabilityAvailabilitySchema,
        interactive: AgentCapabilityAvailabilitySchema,
        platforms: z.array(z.enum(["macos", "linux", "windows"])),
        shared_skill_mcp: z.boolean(),
        visible_session: z.enum([
          "native",
          "host_managed",
          "not_guaranteed",
          "not_applicable",
        ]),
      })
      .strict(),
    display_name: z.string().min(1).max(64),
    id: AgentIntegrationIdSchema,
    inbound: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
        docs_url: z.string().url().nullable(),
        engine: z.enum([
          "host_native",
          "codex_sdk_companion",
          "claude_channel_preview",
          "attention_channel_bridge",
          "none",
        ]),
        minimum_version: z.string().min(1).nullable(),
        requires_byo_api_key: z.boolean(),
        requires_running_cli: z.boolean(),
        stable_alternative: InboundAlternativeSchema.nullable(),
      })
      .strict(),
    install_steps: z.array(AgentInstallationStepSchema).min(4),
    interactive: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
      })
      .strict(),
    /**
     * Operational MCP fields remain top-level for installer compatibility;
     * capability availability lives under `interactive`.
     */
    mcp: z
      .object({
        add_command_template: AgentCommandTemplateSchema.nullable(),
        auth: z.literal("oauth"),
        docs_url: z.string().url(),
        login_command_template: AgentCommandTemplateSchema.nullable(),
        oauth_client: z.literal("dedicated_mcp_client"),
        probe_evidence: z.enum([
          "config_only",
          "health_checked",
          "live_tools",
          "none",
        ]),
        probe_command_template: AgentCommandTemplateSchema.nullable(),
        server_name: z.literal("attention"),
        setup_mode: z.enum([
          "host_ui",
          "interactive_oauth",
          "noninteractive_then_login",
        ]),
        transport: z.literal("streamable_http"),
        url_template: z.literal(ATTENTION_MCP_URL_TEMPLATE),
      })
      .strict(),
    platforms: z.array(z.enum(["macos", "linux", "windows"])).min(1),
    release_stage: z.literal("infrastructure_only"),
    restricted_profile: RestrictedProfileSchema,
    runtime_reporting: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
        heartbeat: z.enum(["runtime", "unavailable"]),
        mode: z.enum(["attention_runtime_oauth", "none"]),
        oauth_client_boundary: z.enum([
          "separate_from_mcp",
          "not_applicable",
        ]),
        pairing_reports: z.boolean(),
        resource_url_template: z
          .literal(ATTENTION_RUNTIME_URL_TEMPLATE)
          .nullable(),
        scopes: z.array(z.enum(CHANNEL_RUNTIME_SCOPES)),
      })
      .strict(),
    /**
     * Operational Skill fields remain top-level for installer compatibility;
     * `availability` prevents a source URL from being mistaken for a native
     * install mechanism.
     */
    skill: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
        bundle_path: z.string().startsWith("/skills/attention/").nullable(),
        bundle_sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        bundle_skill_path: z.string().min(1).nullable(),
        delivery: z.enum([
          "host_import_directory",
          "host_user_directory",
          "host_upload_bundle",
          "remote_url",
          "unpublished_bundle",
        ]),
        docs_url: z.string().url(),
        document_sha256: z.literal(ATTENTION_SKILL_DOCUMENT_SHA256),
        format: z.literal("skill_md"),
        id: z.literal("attention"),
        install: z.enum([
          "git_or_directory",
          "raw_url",
          "filesystem_directory",
          "upload_bundle",
        ]),
        install_command_template: AgentCommandTemplateSchema.nullable(),
        local_path: AgentSkillLocalPathSchema.nullable(),
        package_ref: z.string().min(1).nullable(),
        source_kind: z.enum([
          "github_directory",
          "public_url",
          "local_directory",
          "upload_bundle",
        ]),
        source_path: z.literal(ATTENTION_SKILL_PUBLIC_PATH),
        tool_contract_version: z.literal(
          ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
        ),
        version: z.literal(ATTENTION_SKILL_PACKAGE_VERSION),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const stepIds = value.install_steps.map((step) => step.id);
    if (new Set(stepIds).size !== stepIds.length) {
      context.addIssue({
        code: "custom",
        message: "installation steps must not be duplicated",
        path: ["install_steps"],
      });
    }

    for (const stepId of [
      "detect_host",
      "install_skill",
      "configure_mcp",
      "authorize_mcp",
    ] as const) {
      if (!stepIds.includes(stepId)) {
        context.addIssue({
          code: "custom",
          message: `missing interactive installation step: ${stepId}`,
          path: ["install_steps"],
        });
      }
    }

    const runtimeOAuth =
      value.runtime_reporting.mode === "attention_runtime_oauth";
    if (runtimeOAuth) {
      if (
        value.runtime_reporting.heartbeat !== "runtime" ||
        !value.runtime_reporting.pairing_reports ||
        value.runtime_reporting.oauth_client_boundary !== "separate_from_mcp" ||
        value.runtime_reporting.resource_url_template !==
          ATTENTION_RUNTIME_URL_TEMPLATE ||
        CHANNEL_RUNTIME_SCOPES.some(
          (scope) => !value.runtime_reporting.scopes.includes(scope),
        ) ||
        value.runtime_reporting.scopes.length !== CHANNEL_RUNTIME_SCOPES.length ||
        !stepIds.includes("authorize_runtime") ||
        !stepIds.includes("register_runtime")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Runtime OAuth contracts require exact scopes, a separate client, heartbeat, pairing reports, and registration steps",
          path: ["runtime_reporting"],
        });
      }
    } else if (
      value.runtime_reporting.availability !== "unsupported" ||
      value.runtime_reporting.heartbeat !== "unavailable" ||
      value.runtime_reporting.pairing_reports ||
      value.runtime_reporting.oauth_client_boundary !== "not_applicable" ||
      value.runtime_reporting.resource_url_template !== null ||
      value.runtime_reporting.scopes.length !== 0 ||
      stepIds.includes("authorize_runtime") ||
      stepIds.includes("register_runtime") ||
      stepIds.includes("verify_pairing")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "hosts without a Runtime reporter cannot receive Runtime credentials or claim pairing verification",
        path: ["runtime_reporting"],
      });
    }

    const bridge = value.channel.mode === "bridge";
    if (
      bridge !== value.restricted_profile.required ||
      bridge !== stepIds.includes("configure_restricted_profile")
    ) {
      context.addIssue({
        code: "custom",
        message: "bridge hosts require the restricted profile step",
        path: ["restricted_profile"],
      });
    }
    if (bridge) {
      if (
        value.restricted_profile.template_path !==
          ATTENTION_RESTRICTED_PROFILE_PUBLIC_PATH ||
        value.restricted_profile.allowed_mcp_servers.length !== 1 ||
        value.restricted_profile.denied_capabilities.length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "bridge delivery requires the isolated Attention profile",
          path: ["restricted_profile"],
        });
      }
    } else if (
      value.restricted_profile.template_path !== null ||
      value.restricted_profile.allowed_mcp_servers.length !== 0 ||
      value.restricted_profile.denied_capabilities.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "native hosts do not use the Attention bridge profile",
        path: ["restricted_profile"],
      });
    }

    if (
      value.claims.can_confirm_runtime &&
      value.runtime_reporting.availability !== "available"
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime confirmation requires a shipped reporter",
        path: ["claims", "can_confirm_runtime"],
      });
    }
    if (
      value.claims.can_confirm_channel_pairing &&
      !value.claims.can_confirm_runtime
    ) {
      context.addIssue({
        code: "custom",
        message: "pairing confirmation requires a verifiable Runtime reporter",
        path: ["claims", "can_confirm_channel_pairing"],
      });
    }

    if (
      value.mcp.setup_mode === "host_ui" &&
      (value.mcp.add_command_template !== null ||
        value.mcp.login_command_template !== null ||
        value.mcp.probe_command_template !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "a host-UI MCP setup cannot advertise executable CLI commands",
        path: ["mcp", "setup_mode"],
      });
    }
    if (
      (value.mcp.probe_evidence === "none") !==
      (value.mcp.probe_command_template === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "MCP probe evidence must be none exactly when no probe command exists",
        path: ["mcp", "probe_evidence"],
      });
    }
    if (
      value.mcp.setup_mode === "interactive_oauth" &&
      (value.mcp.add_command_template === null ||
        value.mcp.login_command_template === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "interactive OAuth setup requires an interactive add command and a re-authentication command",
        path: ["mcp", "setup_mode"],
      });
    }
    if (
      value.mcp.setup_mode === "noninteractive_then_login" &&
      (value.mcp.add_command_template === null ||
        value.mcp.login_command_template === null ||
        value.mcp.probe_command_template === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "non-interactive MCP setup requires add, login, and probe commands",
        path: ["mcp", "setup_mode"],
      });
    }

    if (
      value.skill.delivery === "host_user_directory" &&
      (value.skill.install !== "filesystem_directory" ||
        value.skill.install_command_template !== null ||
        value.skill.local_path?.purpose !== "install_target")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "a host user-directory Skill is installed by writing its validated SKILL.md directly",
        path: ["skill", "delivery"],
      });
    }
    if (
      value.skill.delivery === "host_import_directory" &&
      (value.skill.install !== "filesystem_directory" ||
        value.skill.install_command_template === null ||
        value.skill.local_path?.purpose !== "staging_source")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "a host-imported Skill requires a staged directory and a host install command",
        path: ["skill", "delivery"],
      });
    }
    if (
      value.skill.delivery === "remote_url" &&
      (value.skill.install !== "raw_url" ||
        value.skill.install_command_template === null ||
        value.skill.local_path !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "a remote-URL Skill requires a host install command",
        path: ["skill", "delivery"],
      });
    }
    if (
      value.skill.delivery === "host_upload_bundle" &&
      (value.skill.availability !== "available" ||
        value.skill.install !== "upload_bundle" ||
        value.skill.install_command_template !== null ||
        value.skill.local_path !== null ||
        value.skill.package_ref !==
          ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH ||
        value.skill.source_kind !== "upload_bundle" ||
        value.skill.bundle_path !==
          ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH ||
        value.skill.bundle_sha256 !==
          ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256 ||
        value.skill.bundle_skill_path !==
          ATTENTION_WORKBUDDY_SKILL_BUNDLE_SKILL_PATH)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "a shipped upload bundle requires a public package, digest, root SKILL.md, and a manual host import boundary",
        path: ["skill", "delivery"],
      });
    }
    if (
      value.skill.delivery !== "host_upload_bundle" &&
      (value.skill.bundle_path !== null ||
        value.skill.bundle_sha256 !== null ||
        value.skill.bundle_skill_path !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "non-bundle Skill deliveries cannot advertise bundle metadata",
        path: ["skill", "delivery"],
      });
    }
    if (
      value.skill.delivery === "unpublished_bundle" &&
      (value.skill.availability !== "contract_only" ||
        value.skill.install !== "upload_bundle" ||
        value.skill.install_command_template !== null ||
        value.skill.local_path !== null ||
        value.skill.package_ref !== null ||
        value.skill.bundle_path !== null ||
        value.skill.bundle_sha256 !== null ||
        value.skill.bundle_skill_path !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "an unpublished upload bundle must remain contract-only and expose no package or install command",
        path: ["skill", "delivery"],
      });
    }

    if (value.skill.local_path) {
      const supportsPosix =
        value.platforms.includes("macos") || value.platforms.includes("linux");
      const supportsWindows = value.platforms.includes("windows");
      if (
        (supportsPosix && value.skill.local_path.posix_directory === null) ||
        (!supportsPosix && value.skill.local_path.posix_directory !== null) ||
        (supportsWindows && value.skill.local_path.windows_directory === null) ||
        (!supportsWindows && value.skill.local_path.windows_directory !== null)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "local Skill paths must cover exactly the operating systems supported by the host",
          path: ["skill", "local_path"],
        });
      }
    }
  });

export type AgentInstallationProfile = z.infer<
  typeof AgentInstallationProfileSchema
>;

export const AgentInstallationCatalogSchema = z
  .object({
    boundaries: z
      .object({
        hosted_agent: z.literal(false),
        hosted_channel_ui: z.literal(false),
        local_channel_credentials_uploaded: z.literal(false),
      })
      .strict(),
    command_placeholders: z
      .array(z.enum(AGENT_COMMAND_TEMPLATE_PLACEHOLDERS))
      .length(AGENT_COMMAND_TEMPLATE_PLACEHOLDERS.length),
    docs_path: z.literal(ATTENTION_INSTALL_GUIDE_PUBLIC_PATH),
    integrations: z
      .array(
        z
          .object({
            id: AgentIntegrationIdSchema,
            manifest_path: z.string().startsWith(
              "/skills/attention/installations/v1/agents/",
            ),
          })
          .strict(),
      )
      .length(AGENT_INTEGRATION_IDS.length),
    migration: z
      .object({
        from_schema: z.literal("2.2.0"),
        guide_anchor: z.literal("#schema-23-migration"),
      })
      .strict(),
    release_stage: z.literal("infrastructure_only"),
    schema_version: z.literal(AGENT_INSTALLATION_MANIFEST_SCHEMA_VERSION),
    skill: z
      .object({
        id: z.literal("attention"),
        document_sha256: z.literal(ATTENTION_SKILL_DOCUMENT_SHA256),
        source_path: z.literal(ATTENTION_SKILL_PUBLIC_PATH),
        tool_contract_version: z.literal(
          ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
        ),
        version: z.literal(ATTENTION_SKILL_PACKAGE_VERSION),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.integrations.map((integration) => integration.id);
    if (
      new Set(ids).size !== AGENT_INTEGRATION_IDS.length ||
      AGENT_INTEGRATION_IDS.some((id) => !ids.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "catalog must reference every v1 Agent exactly once",
        path: ["integrations"],
      });
    }
  });

export type AgentInstallationCatalog = z.infer<
  typeof AgentInstallationCatalogSchema
>;

export const RestrictedAgentProfileTemplateSchema = z
  .object({
    capabilities: z
      .object({
        allow_mcp_servers: z.array(z.literal("attention")).length(1),
        allow_mcp_tool_prefixes: z.array(z.literal("attention_")).length(1),
        deny: z.array(
          z.enum([
            "arbitrary_mcp",
            "browser_automation",
            "code_execution",
            "filesystem_write",
            "shell",
          ]),
        ),
      })
      .strict(),
    context: z
      .object({
        inherit_session_history: z.literal(false),
        inherit_working_directory: z.literal(false),
      })
      .strict(),
    id: z.literal("attention-channel-restricted"),
    logging: z
      .object({
        include_channel_credentials: z.literal(false),
        include_full_message_body: z.literal(false),
      })
      .strict(),
    schema_version: z.literal(AGENT_INSTALLATION_MANIFEST_SCHEMA_VERSION),
  })
  .strict();

export type RestrictedAgentProfileTemplate = z.infer<
  typeof RestrictedAgentProfileTemplateSchema
>;

const availableStep = (
  step: Omit<AgentInstallationStep, "availability">,
): AgentInstallationStep => ({ ...step, availability: "available" });

const command = (
  executable: string,
  ...args: string[]
): AgentCommandTemplate => ({ args, executable });

const baseSteps: readonly AgentInstallationStep[] = [
  availableStep({
    credential_target: "none",
    executor: "attention_installer",
    id: "detect_host",
    requires_browser: false,
  }),
  availableStep({
    credential_target: "none",
    executor: "attention_installer",
    id: "install_skill",
    requires_browser: false,
  }),
  availableStep({
    credential_target: "none",
    executor: "attention_installer",
    id: "configure_mcp",
    requires_browser: false,
  }),
  availableStep({
    credential_target: "mcp_oauth",
    executor: "user",
    id: "authorize_mcp",
    requires_browser: true,
  }),
];

const HOST_DETAILS = {
  "claude-code": {
    channelDocs: null,
    channelPackage: null,
    channelSetupCommands: [
      command(
        "attention",
        "channel",
        "start",
        "claude-code",
        "--origin",
        "{attention_origin}",
        "--background",
      ),
    ] as AgentCommandTemplate[],
    inboundDocs: null,
    compatibilityMinimumVersion: "2.1.226",
    compatibilityChecks: [] as AgentCommandTemplate[],
    mcp: {
      add: command(
        "claude",
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        "attention",
        "{mcp_url}",
      ),
      docs: "https://code.claude.com/docs/en/mcp",
      login: command("claude", "mcp", "login", "attention"),
      probe: command("claude", "mcp", "get", "attention"),
      probeEvidence: "config_only" as const,
      setupMode: "noninteractive_then_login" as const,
    },
    skill: {
      bundlePath: null,
      bundleSha256: null,
      bundleSkillPath: null,
      delivery: "host_user_directory" as const,
      docs: "https://code.claude.com/docs/en/skills",
      install: "filesystem_directory" as const,
      installCommand: null,
      localPath: {
        entrypoint: "SKILL.md" as const,
        posixDirectory: "~/.claude/skills/attention",
        purpose: "install_target" as const,
        windowsDirectory: "%USERPROFILE%\\.claude\\skills\\attention",
      },
      packageRef: null,
      sourceKind: "local_directory" as const,
    },
  },
  codex: {
    channelDocs: null,
    channelPackage: null,
    channelSetupCommands: [
      command(
        "attention",
        "channel",
        "start",
        "codex",
        "--origin",
        "{attention_origin}",
        "--background",
      ),
    ] as AgentCommandTemplate[],
    inboundDocs: null,
    compatibilityMinimumVersion: null,
    compatibilityChecks: [
      command("codex", "app-server", "--help"),
      command("codex", "mcp", "add", "--help"),
      command("codex", "mcp", "get", "--help"),
    ],
    mcp: {
      add: command("codex", "mcp", "add", "attention", "--url", "{mcp_url}"),
      docs: "https://learn.chatgpt.com/docs/extend/mcp",
      login: command("codex", "mcp", "login", "attention"),
      probe: command("codex", "mcp", "get", "attention", "--json"),
      probeEvidence: "config_only" as const,
      setupMode: "noninteractive_then_login" as const,
    },
    skill: {
      bundlePath: null,
      bundleSha256: null,
      bundleSkillPath: null,
      delivery: "host_user_directory" as const,
      docs: "https://learn.chatgpt.com/docs/build-skills",
      install: "filesystem_directory" as const,
      installCommand: null,
      localPath: {
        entrypoint: "SKILL.md" as const,
        posixDirectory: "~/.agents/skills/attention",
        purpose: "install_target" as const,
        windowsDirectory: "%USERPROFILE%\\.agents\\skills\\attention",
      },
      packageRef: null,
      sourceKind: "local_directory" as const,
    },
  },
  hermes: {
    channelDocs:
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/weixin.md",
    channelPackage: null,
    channelSetupCommands: [
      command("hermes", "gateway", "setup"),
      command("hermes", "gateway", "status"),
    ],
    inboundDocs:
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md",
    compatibilityMinimumVersion: null,
    compatibilityChecks: [
      command("hermes", "skills", "install", "--help"),
      command("hermes", "mcp", "add", "--help"),
      command("hermes", "mcp", "test", "--help"),
    ],
    mcp: {
      add: command(
        "hermes",
        "mcp",
        "add",
        "attention",
        "--url",
        "{mcp_url}",
        "--auth",
        "oauth",
      ),
      docs:
        "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md",
      login: command("hermes", "mcp", "login", "attention"),
      probe: command("hermes", "mcp", "test", "attention"),
      probeEvidence: "health_checked" as const,
      setupMode: "interactive_oauth" as const,
    },
    skill: {
      bundlePath: null,
      bundleSha256: null,
      bundleSkillPath: null,
      delivery: "remote_url" as const,
      docs:
        "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md",
      install: "raw_url" as const,
      installCommand: command("hermes", "skills", "install", "{skill_url}"),
      localPath: null,
      packageRef: null,
      sourceKind: "public_url" as const,
    },
  },
  openclaw: {
    channelDocs:
      "https://github.com/Tencent/openclaw-weixin",
    channelPackage: "@tencent-weixin/openclaw-weixin@2.4.6",
    channelSetupCommands: [
      command(
        "openclaw",
        "plugins",
        "install",
        "@tencent-weixin/openclaw-weixin@2.4.6",
      ),
      command(
        "openclaw",
        "config",
        "set",
        "plugins.entries.openclaw-weixin.enabled",
        "true",
      ),
      command(
        "openclaw",
        "channels",
        "login",
        "--channel",
        "openclaw-weixin",
      ),
      command("openclaw", "gateway", "restart"),
      command("openclaw", "channels", "status", "--probe"),
    ],
    inboundDocs:
      "https://github.com/openclaw/openclaw/blob/main/docs/channels/wechat.md",
    compatibilityMinimumVersion: "2026.5.12",
    compatibilityChecks: [] as AgentCommandTemplate[],
    mcp: {
      add: command(
        "openclaw",
        "mcp",
        "add",
        "attention",
        "--url",
        "{mcp_url}",
        "--transport",
        "streamable-http",
        "--auth",
        "oauth",
      ),
      docs: "https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md",
      login: command("openclaw", "mcp", "login", "attention"),
      probe: command("openclaw", "mcp", "doctor", "attention", "--probe"),
      probeEvidence: "health_checked" as const,
      setupMode: "noninteractive_then_login" as const,
    },
    skill: {
      bundlePath: null,
      bundleSha256: null,
      bundleSkillPath: null,
      delivery: "host_import_directory" as const,
      docs: "https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md",
      install: "filesystem_directory" as const,
      installCommand: command(
        "openclaw",
        "skills",
        "install",
        "{attention_skill_directory}",
        "--as",
        "attention",
      ),
      localPath: {
        entrypoint: "SKILL.md" as const,
        posixDirectory: "./attention-skill",
        purpose: "staging_source" as const,
        windowsDirectory: ".\\attention-skill",
      },
      packageRef: null,
      sourceKind: "public_url" as const,
    },
  },
  workbuddy: {
    channelDocs: "https://www.codebuddy.cn/docs/workbuddy/WeixinBot-Guide",
    channelPackage: null,
    channelSetupCommands: [] as AgentCommandTemplate[],
    inboundDocs: "https://www.codebuddy.cn/docs/workbuddy/WeixinBot-Guide",
    compatibilityMinimumVersion: "4.8.2",
    compatibilityChecks: [] as AgentCommandTemplate[],
    mcp: {
      add: null,
      docs:
        "https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide",
      login: null,
      probe: null,
      probeEvidence: "none" as const,
      setupMode: "host_ui" as const,
    },
    skill: {
      bundlePath: ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
      bundleSha256: ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
      bundleSkillPath: ATTENTION_WORKBUDDY_SKILL_BUNDLE_SKILL_PATH,
      delivery: "host_upload_bundle" as const,
      docs:
        "https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market",
      install: "upload_bundle" as const,
      installCommand: null,
      localPath: null,
      packageRef: ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
      sourceKind: "upload_bundle" as const,
    },
  },
} as const satisfies Record<
  AgentIntegration["id"],
  {
    channelDocs: string | null;
    channelPackage: string | null;
    channelSetupCommands: readonly AgentCommandTemplate[];
    compatibilityMinimumVersion: string | null;
    compatibilityChecks: readonly AgentCommandTemplate[];
    inboundDocs: string | null;
    mcp: {
      add: AgentCommandTemplate | null;
      docs: string;
      login: AgentCommandTemplate | null;
      probe: AgentCommandTemplate | null;
      probeEvidence:
        | "config_only"
        | "health_checked"
        | "live_tools"
        | "none";
      setupMode:
        | "host_ui"
        | "interactive_oauth"
        | "noninteractive_then_login";
    };
    skill: {
      bundlePath: string | null;
      bundleSha256: string | null;
      bundleSkillPath: string | null;
      delivery:
        | "host_import_directory"
        | "host_user_directory"
        | "host_upload_bundle"
        | "remote_url"
        | "unpublished_bundle";
      docs: string;
      install:
        | "git_or_directory"
        | "raw_url"
        | "filesystem_directory"
        | "upload_bundle";
      installCommand: AgentCommandTemplate | null;
      localPath: {
        entrypoint: "SKILL.md";
        posixDirectory: string | null;
        purpose: "install_target" | "staging_source";
        windowsDirectory: string | null;
      } | null;
      packageRef: string | null;
      sourceKind:
        | "github_directory"
        | "public_url"
        | "local_directory"
        | "upload_bundle";
    };
  }
>;

function createInstallSteps(
  integration: AgentIntegration,
): readonly AgentInstallationStep[] {
  const setupMode = HOST_DETAILS[integration.id].mcp.setupMode;
  const steps = baseSteps.map((step) => {
    if (step.id === "install_skill") {
      return { ...step, availability: integration.interactive.skill };
    }
    if (step.id === "configure_mcp" && setupMode !== "noninteractive_then_login") {
      return { ...step, executor: "user" as const };
    }
    return step;
  });

  if (integration.channel.mode === "bridge") {
    steps.push({
      availability: integration.channel.availability,
      credential_target: "none",
      executor: "attention_installer",
      id: "configure_restricted_profile",
      requires_browser: false,
    });
  }

  if (integration.runtime_reporting.mode === "attention_runtime_oauth") {
    steps.push(
      {
        availability: integration.runtime_reporting.availability,
        credential_target: "runtime_oauth",
        executor: "user",
        id: "authorize_runtime",
        requires_browser: true,
      },
      {
        availability: integration.runtime_reporting.availability,
        credential_target: "runtime_oauth",
        executor: "attention_installer",
        id: "register_runtime",
        requires_browser: false,
      },
    );
  }

  if (integration.channel.availability !== "unsupported") {
    steps.push({
      availability: integration.channel.availability,
      credential_target: "local_channel",
      executor: "user",
      id: "connect_channel",
      requires_browser: false,
    });
  }

  if (
    integration.inbound.engine === "codex_sdk_companion" ||
    integration.inbound.engine === "claude_channel_preview" ||
    integration.inbound.engine === "attention_channel_bridge"
  ) {
    steps.push({
      availability: integration.inbound.availability,
      credential_target: "local_channel",
      executor: "attention_installer",
      id: "start_inbound",
      requires_browser: false,
    });
  }

  if (integration.runtime_reporting.mode === "attention_runtime_oauth") {
    steps.push({
      availability: integration.runtime_reporting.availability,
      credential_target: "none",
      executor: "host",
      id: "verify_pairing",
      requires_browser: false,
    });
  }

  return steps;
}

function createInstallationProfile(
  integration: AgentIntegration,
): AgentInstallationProfile {
  const details = HOST_DETAILS[integration.id];
  const bridge = integration.channel.mode === "bridge";
  const runtimeOAuth =
    integration.runtime_reporting.mode === "attention_runtime_oauth";

  return AgentInstallationProfileSchema.parse({
    acceptance: {
      config_probe_is_acceptance: false,
      requirement: "successful_tool_result",
      tool_name: ATTENTION_INSTALL_ACCEPTANCE_TOOL,
    },
    channel: {
      availability: integration.channel.availability,
      credentials: "local_device_only",
      docs_url: details.channelDocs,
      hosted_by_attention: false,
      minimum_version:
        integration.id === "openclaw" ? integration.inbound.minimum_version : null,
      mode: integration.channel.mode,
      owner: integration.channel.owner,
      package_ref: details.channelPackage,
      setup: integration.channel.setup,
      setup_command_templates: [...details.channelSetupCommands],
      status_evidence: integration.channel.status_evidence,
    },
    claims: integration.claims,
    compatibility: {
      command_checks: [...details.compatibilityChecks],
      minimum_version: details.compatibilityMinimumVersion,
      policy:
        details.compatibilityMinimumVersion === null
          ? "verify_at_install"
          : "pinned",
    },
    desktop: integration.desktop,
    display_name: integration.display_name,
    id: integration.id,
    inbound: {
      ...integration.inbound,
      docs_url: details.inboundDocs,
    },
    install_steps: createInstallSteps(integration),
    interactive: {
      availability: integration.interactive.availability,
    },
    mcp: {
      add_command_template: details.mcp.add,
      auth: "oauth",
      docs_url: details.mcp.docs,
      login_command_template: details.mcp.login,
      oauth_client: "dedicated_mcp_client",
      probe_evidence: details.mcp.probeEvidence,
      probe_command_template: details.mcp.probe,
      server_name: "attention",
      setup_mode: details.mcp.setupMode,
      transport: "streamable_http",
      url_template: ATTENTION_MCP_URL_TEMPLATE,
    },
    platforms: integration.platforms,
    release_stage: "infrastructure_only",
    restricted_profile: {
      allowed_mcp_servers: bridge ? ["attention"] : [],
      denied_capabilities: bridge
        ? [
            "arbitrary_mcp",
            "browser_automation",
            "code_execution",
            "filesystem_write",
            "shell",
          ]
        : [],
      required: bridge,
      template_path: bridge
        ? ATTENTION_RESTRICTED_PROFILE_PUBLIC_PATH
        : null,
    },
    runtime_reporting: {
      availability: integration.runtime_reporting.availability,
      heartbeat: integration.runtime_reporting.heartbeat,
      mode: integration.runtime_reporting.mode,
      oauth_client_boundary: runtimeOAuth
        ? "separate_from_mcp"
        : "not_applicable",
      pairing_reports: integration.runtime_reporting.pairing_reports,
      resource_url_template: runtimeOAuth
        ? ATTENTION_RUNTIME_URL_TEMPLATE
        : null,
      scopes: runtimeOAuth ? CHANNEL_RUNTIME_SCOPES : [],
    },
    skill: {
      availability: integration.interactive.skill,
      bundle_path: details.skill.bundlePath,
      bundle_sha256: details.skill.bundleSha256,
      bundle_skill_path: details.skill.bundleSkillPath,
      delivery: details.skill.delivery,
      docs_url: details.skill.docs,
      document_sha256: ATTENTION_SKILL_DOCUMENT_SHA256,
      format: "skill_md",
      id: "attention",
      install: details.skill.install,
      install_command_template: details.skill.installCommand,
      local_path: details.skill.localPath
        ? {
            entrypoint: details.skill.localPath.entrypoint,
            posix_directory: details.skill.localPath.posixDirectory,
            purpose: details.skill.localPath.purpose,
            windows_directory: details.skill.localPath.windowsDirectory,
          }
        : null,
      package_ref: details.skill.packageRef,
      source_kind: details.skill.sourceKind,
      source_path: ATTENTION_SKILL_PUBLIC_PATH,
      tool_contract_version: ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
      version: ATTENTION_SKILL_PACKAGE_VERSION,
    },
  });
}

export const agentInstallationProfiles: readonly AgentInstallationProfile[] =
  agentIntegrationManifest.map(createInstallationProfile);

const profileById = new Map(
  agentInstallationProfiles.map((profile) => [profile.id, profile]),
);

export function getAgentInstallationProfile(
  id: z.infer<typeof AgentIntegrationIdSchema>,
): AgentInstallationProfile {
  const profile = profileById.get(id);
  if (!profile) throw new Error(`Unknown Agent installation profile: ${id}`);
  return profile;
}

export const agentInstallationCatalog: AgentInstallationCatalog =
  AgentInstallationCatalogSchema.parse({
    boundaries: {
      hosted_agent: false,
      hosted_channel_ui: false,
      local_channel_credentials_uploaded: false,
    },
    command_placeholders: [...AGENT_COMMAND_TEMPLATE_PLACEHOLDERS],
    docs_path: ATTENTION_INSTALL_GUIDE_PUBLIC_PATH,
    integrations: AGENT_INTEGRATION_IDS.map((id) => ({
      id,
      manifest_path: `/skills/attention/installations/v1/agents/${id}.json`,
    })),
    migration: {
      from_schema: "2.2.0",
      guide_anchor: "#schema-23-migration",
    },
    /**
     * `infrastructure_only` describes Attention's hosted surface: the catalog
     * still ships no Hosted Agent or Hosted Channel UI. The local
     * attention-channel bridge (schema 2.3.0) runs on the user's device.
     */
    release_stage: "infrastructure_only",
    schema_version: AGENT_INSTALLATION_MANIFEST_SCHEMA_VERSION,
    skill: {
      document_sha256: ATTENTION_SKILL_DOCUMENT_SHA256,
      id: "attention",
      source_path: ATTENTION_SKILL_PUBLIC_PATH,
      tool_contract_version: ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
      version: ATTENTION_SKILL_PACKAGE_VERSION,
    },
  });

export const restrictedAgentProfileTemplate: RestrictedAgentProfileTemplate =
  RestrictedAgentProfileTemplateSchema.parse({
    capabilities: {
      allow_mcp_servers: ["attention"],
      allow_mcp_tool_prefixes: ["attention_"],
      deny: [
        "arbitrary_mcp",
        "browser_automation",
        "code_execution",
        "filesystem_write",
        "shell",
      ],
    },
    context: {
      inherit_session_history: false,
      inherit_working_directory: false,
    },
    id: "attention-channel-restricted",
    logging: {
      include_channel_credentials: false,
      include_full_message_body: false,
    },
    schema_version: AGENT_INSTALLATION_MANIFEST_SCHEMA_VERSION,
  });
