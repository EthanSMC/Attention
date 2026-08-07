import { z } from "zod";

export const AGENT_INTEGRATION_IDS = [
  "openclaw",
  "hermes",
  "codex",
  "claude-code",
  "workbuddy",
] as const;

export const AgentIntegrationIdSchema = z.enum(AGENT_INTEGRATION_IDS);
export type AgentIntegrationId = z.infer<typeof AgentIntegrationIdSchema>;

export const AgentCapabilityAvailabilitySchema = z.enum([
  "available",
  "available_external",
  "experimental",
  "contract_only",
  "host_managed_unverifiable",
  "unsupported",
]);
export type AgentCapabilityAvailability = z.infer<
  typeof AgentCapabilityAvailabilitySchema
>;

/**
 * Product capability contract for a local Agent host.
 *
 * The six capability axes are intentionally independent. In particular,
 * working Skill/MCP integration is not evidence that a WeChat adapter, a
 * background inbound runtime, or a Desktop wake-up path has shipped.
 */
export const AgentIntegrationSchema = z
  .object({
    claims: z
      .object({
        can_confirm_channel_pairing: z.boolean(),
        can_confirm_mcp: z.boolean(),
        can_confirm_runtime: z.boolean(),
        can_confirm_wechat_identity: z.literal(false),
      })
      .strict(),
    channel: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
        mode: z.enum(["native", "bridge"]),
        owner: z.enum([
          "openclaw",
          "hermes",
          "attention-channel",
          "workbuddy",
        ]),
        setup: z.enum([
          "host_cli_qr",
          "host_ui_qr",
          "attention_cli_qr",
        ]),
        status_evidence: z.enum([
          "host_cli_probe",
          "host_ui_only",
          "running_cli_only",
          "none",
        ]),
      })
      .strict(),
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
        engine: z.enum([
          "host_native",
          "codex_sdk_companion",
          "claude_channel_preview",
          "none",
        ]),
        minimum_version: z.string().min(1).nullable(),
        requires_byo_api_key: z.boolean(),
        requires_running_cli: z.boolean(),
        stable_alternative: z
          .object({
            availability: AgentCapabilityAvailabilitySchema,
            engine: z.literal("claude_agent_sdk_byo_key"),
            requires_byo_api_key: z.literal(true),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    interactive: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
        mcp: AgentCapabilityAvailabilitySchema,
        skill: AgentCapabilityAvailabilitySchema,
      })
      .strict(),
    platforms: z.array(z.enum(["macos", "linux", "windows"])).min(1),
    runtime_reporting: z
      .object({
        availability: AgentCapabilityAvailabilitySchema,
        heartbeat: z.enum(["runtime", "unavailable"]),
        mode: z.enum(["attention_runtime_oauth", "none"]),
        pairing_reports: z.boolean(),
      })
      .strict(),
    security: z
      .object({
        channel_tokens_leave_device: z.literal(false),
        restricted_profile_required: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const bridge = value.channel.mode === "bridge";
    if (value.security.restricted_profile_required !== bridge) {
      context.addIssue({
        code: "custom",
        message: "bridge agents require an isolated Attention-only profile",
        path: ["security", "restricted_profile_required"],
      });
    }
    if (bridge && value.channel.owner !== "attention-channel") {
      context.addIssue({
        code: "custom",
        message: "bridge agents must use the Attention channel owner",
        path: ["channel", "owner"],
      });
    }

    const runtimeOAuth =
      value.runtime_reporting.mode === "attention_runtime_oauth";
    if (
      runtimeOAuth !== (value.runtime_reporting.heartbeat === "runtime") ||
      runtimeOAuth !== value.runtime_reporting.pairing_reports
    ) {
      context.addIssue({
        code: "custom",
        message:
          "the Runtime OAuth contract owns heartbeat and pairing reports together",
        path: ["runtime_reporting"],
      });
    }
    if (
      !runtimeOAuth &&
      value.runtime_reporting.availability !== "unsupported"
    ) {
      context.addIssue({
        code: "custom",
        message: "a host without Runtime reporting must mark it unsupported",
        path: ["runtime_reporting", "availability"],
      });
    }

    if (
      value.claims.can_confirm_runtime &&
      value.runtime_reporting.availability !== "available"
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime confirmation requires a shipped Runtime reporter",
        path: ["claims", "can_confirm_runtime"],
      });
    }
    if (
      value.claims.can_confirm_channel_pairing &&
      !value.claims.can_confirm_runtime
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Attention cannot confirm local channel pairing without a verifiable reporter",
        path: ["claims", "can_confirm_channel_pairing"],
      });
    }

    if (
      value.desktop.inbound === "unsupported" &&
      value.desktop.visible_session !== "not_applicable"
    ) {
      context.addIssue({
        code: "custom",
        message: "unsupported Desktop inbound cannot promise a visible session",
        path: ["desktop", "visible_session"],
      });
    }
    if (
      value.desktop.interactive === "unsupported" &&
      value.desktop.shared_skill_mcp
    ) {
      context.addIssue({
        code: "custom",
        message: "unsupported Desktop interaction cannot share Skill/MCP",
        path: ["desktop", "shared_skill_mcp"],
      });
    }
    if (
      (value.desktop.interactive === "unsupported") !==
      (value.desktop.platforms.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Desktop platforms must be empty exactly when Desktop interaction is unsupported",
        path: ["desktop", "platforms"],
      });
    }

    if (value.inbound.engine === "none") {
      if (
        value.inbound.availability !== "unsupported" ||
        value.inbound.minimum_version !== null ||
        value.inbound.requires_byo_api_key ||
        value.inbound.requires_running_cli ||
        value.inbound.stable_alternative !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "an unsupported inbound engine cannot declare runtime requirements",
          path: ["inbound"],
        });
      }
    }
    if (
      value.inbound.engine === "claude_channel_preview" &&
      (
        value.inbound.availability !== "experimental" ||
        !value.inbound.requires_running_cli ||
        value.inbound.stable_alternative?.engine !==
          "claude_agent_sdk_byo_key"
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Claude Channels are experimental, require a running CLI, and need a BYO-key SDK alternative for stable background use",
        path: ["inbound"],
      });
    }
  });

export type AgentIntegration = z.infer<typeof AgentIntegrationSchema>;

const manifestInput = [
  {
    claims: {
      can_confirm_channel_pairing: false,
      can_confirm_mcp: true,
      can_confirm_runtime: false,
      can_confirm_wechat_identity: false,
    },
    channel: {
      availability: "available_external",
      mode: "native",
      owner: "openclaw",
      setup: "host_cli_qr",
      status_evidence: "host_cli_probe",
    },
    desktop: {
      inbound: "unsupported",
      interactive: "available",
      platforms: ["macos", "windows"],
      shared_skill_mcp: true,
      visible_session: "not_applicable",
    },
    display_name: "OpenClaw",
    id: "openclaw",
    inbound: {
      availability: "available_external",
      engine: "host_native",
      minimum_version: "2026.5.12",
      requires_byo_api_key: false,
      requires_running_cli: false,
      stable_alternative: null,
    },
    interactive: {
      availability: "available",
      mcp: "available",
      skill: "available",
    },
    platforms: ["macos", "linux", "windows"],
    runtime_reporting: {
      availability: "contract_only",
      heartbeat: "runtime",
      mode: "attention_runtime_oauth",
      pairing_reports: true,
    },
    security: {
      channel_tokens_leave_device: false,
      restricted_profile_required: false,
    },
  },
  {
    claims: {
      can_confirm_channel_pairing: false,
      can_confirm_mcp: true,
      can_confirm_runtime: false,
      can_confirm_wechat_identity: false,
    },
    channel: {
      availability: "available_external",
      mode: "native",
      owner: "hermes",
      setup: "host_cli_qr",
      status_evidence: "host_cli_probe",
    },
    desktop: {
      inbound: "unsupported",
      interactive: "available",
      platforms: ["macos", "linux", "windows"],
      shared_skill_mcp: true,
      visible_session: "not_applicable",
    },
    display_name: "Hermes Agent",
    id: "hermes",
    inbound: {
      availability: "available_external",
      engine: "host_native",
      minimum_version: null,
      requires_byo_api_key: false,
      requires_running_cli: false,
      stable_alternative: null,
    },
    interactive: {
      availability: "available",
      mcp: "available",
      skill: "available",
    },
    platforms: ["macos", "linux", "windows"],
    runtime_reporting: {
      availability: "contract_only",
      heartbeat: "runtime",
      mode: "attention_runtime_oauth",
      pairing_reports: true,
    },
    security: {
      channel_tokens_leave_device: false,
      restricted_profile_required: false,
    },
  },
  {
    claims: {
      can_confirm_channel_pairing: false,
      can_confirm_mcp: true,
      can_confirm_runtime: false,
      can_confirm_wechat_identity: false,
    },
    channel: {
      availability: "contract_only",
      mode: "bridge",
      owner: "attention-channel",
      setup: "attention_cli_qr",
      status_evidence: "none",
    },
    desktop: {
      inbound: "unsupported",
      interactive: "available",
      platforms: ["macos", "windows"],
      shared_skill_mcp: true,
      visible_session: "not_applicable",
    },
    display_name: "Codex",
    id: "codex",
    inbound: {
      availability: "contract_only",
      engine: "codex_sdk_companion",
      minimum_version: null,
      requires_byo_api_key: false,
      requires_running_cli: false,
      stable_alternative: null,
    },
    interactive: {
      availability: "available",
      mcp: "available",
      skill: "available",
    },
    platforms: ["macos", "linux", "windows"],
    runtime_reporting: {
      availability: "contract_only",
      heartbeat: "runtime",
      mode: "attention_runtime_oauth",
      pairing_reports: true,
    },
    security: {
      channel_tokens_leave_device: false,
      restricted_profile_required: true,
    },
  },
  {
    claims: {
      can_confirm_channel_pairing: false,
      can_confirm_mcp: true,
      can_confirm_runtime: false,
      can_confirm_wechat_identity: false,
    },
    channel: {
      availability: "contract_only",
      mode: "bridge",
      owner: "attention-channel",
      setup: "attention_cli_qr",
      status_evidence: "running_cli_only",
    },
    desktop: {
      inbound: "unsupported",
      interactive: "available",
      platforms: ["macos", "linux", "windows"],
      shared_skill_mcp: true,
      visible_session: "not_applicable",
    },
    display_name: "Claude Code",
    id: "claude-code",
    inbound: {
      availability: "experimental",
      engine: "claude_channel_preview",
      minimum_version: "2.1.80",
      requires_byo_api_key: false,
      requires_running_cli: true,
      stable_alternative: {
        availability: "contract_only",
        engine: "claude_agent_sdk_byo_key",
        requires_byo_api_key: true,
      },
    },
    interactive: {
      availability: "available",
      mcp: "available",
      skill: "available",
    },
    platforms: ["macos", "linux", "windows"],
    runtime_reporting: {
      availability: "contract_only",
      heartbeat: "runtime",
      mode: "attention_runtime_oauth",
      pairing_reports: true,
    },
    security: {
      channel_tokens_leave_device: false,
      restricted_profile_required: true,
    },
  },
  {
    claims: {
      can_confirm_channel_pairing: false,
      can_confirm_mcp: true,
      can_confirm_runtime: false,
      can_confirm_wechat_identity: false,
    },
    channel: {
      availability: "host_managed_unverifiable",
      mode: "native",
      owner: "workbuddy",
      setup: "host_ui_qr",
      status_evidence: "host_ui_only",
    },
    desktop: {
      inbound: "host_managed_unverifiable",
      interactive: "available",
      platforms: ["macos", "windows"],
      shared_skill_mcp: true,
      visible_session: "host_managed",
    },
    display_name: "WorkBuddy",
    id: "workbuddy",
    inbound: {
      availability: "host_managed_unverifiable",
      engine: "host_native",
      minimum_version: null,
      requires_byo_api_key: false,
      requires_running_cli: false,
      stable_alternative: null,
    },
    interactive: {
      availability: "available",
      mcp: "available",
      skill: "available",
    },
    platforms: ["macos", "windows"],
    runtime_reporting: {
      availability: "unsupported",
      heartbeat: "unavailable",
      mode: "none",
      pairing_reports: false,
    },
    security: {
      channel_tokens_leave_device: false,
      restricted_profile_required: false,
    },
  },
] as const;

export const agentIntegrationManifest: readonly AgentIntegration[] =
  manifestInput.map((entry) => AgentIntegrationSchema.parse(entry));

const integrationById = new Map(
  agentIntegrationManifest.map((integration) => [integration.id, integration]),
);

export function getAgentIntegration(id: AgentIntegrationId): AgentIntegration {
  const integration = integrationById.get(id);
  if (!integration) throw new Error(`Unknown Agent integration: ${id}`);
  return integration;
}
