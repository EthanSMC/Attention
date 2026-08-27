import { z } from "zod";

import {
  AgentIntegrationIdSchema,
  type AgentIntegrationId,
} from "./agent-integration";

/**
 * Version of the local runtime control-plane contract. This is deliberately
 * independent from MCP transport and tool naming.
 */
export const CHANNEL_RUNTIME_API_VERSION = "1" as const;
export const ChannelRuntimeApiVersionSchema = z.literal(
  CHANNEL_RUNTIME_API_VERSION,
);

export const CHANNEL_RUNTIME_RESOURCE = "attention-channel-runtime" as const;
export const ChannelRuntimeResourceSchema = z.literal(
  CHANNEL_RUNTIME_RESOURCE,
);

export const CHANNEL_RUNTIME_SCOPES = [
  "runtime:register",
  "runtime:heartbeat",
  "channel:bind:report",
  "channel:disconnect:report",
  "channel:notifications:read",
] as const;
export const ChannelRuntimeScopeSchema = z.enum(CHANNEL_RUNTIME_SCOPES);
export type ChannelRuntimeScope = z.infer<typeof ChannelRuntimeScopeSchema>;

export const CHANNEL_SUMMARY_READY_EVENT_TYPE =
  "content.summary.ready.v1" as const;

export function summaryReadyNotificationDedupeKey(contentId: string): string {
  return `${CHANNEL_SUMMARY_READY_EVENT_TYPE}:${contentId}`;
}

export const ChannelSummaryNotificationCursorSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );

export const LOCAL_CHANNEL_PROVIDERS = [
  "wechat_ilink",
  "workbuddy_wechat",
] as const;
export const LocalChannelProviderSchema = z.enum(LOCAL_CHANNEL_PROVIDERS);
export type LocalChannelProvider = z.infer<typeof LocalChannelProviderSchema>;

export const CHANNEL_OWNER_KINDS = ["native", "bridge"] as const;
export const ChannelOwnerKindSchema = z.enum(CHANNEL_OWNER_KINDS);
export type ChannelOwnerKind = z.infer<typeof ChannelOwnerKindSchema>;

export const INSTALLATION_STATUSES = [
  "registered",
  "active",
  "degraded",
  "stale",
  "disconnected",
  "revoked",
] as const;
export const InstallationStatusSchema = z.enum(INSTALLATION_STATUSES);
export type InstallationStatus = z.infer<typeof InstallationStatusSchema>;

export const CHANNEL_BINDING_STATUSES = [
  "reported",
  "verified",
  "healthy",
  "stale",
  "disconnected",
  "revoked",
] as const;
export const ChannelBindingStatusSchema = z.enum(CHANNEL_BINDING_STATUSES);
export type ChannelBindingStatus = z.infer<
  typeof ChannelBindingStatusSchema
>;

export const InstallationIdSchema = z.string().uuid();
export type InstallationId = z.infer<typeof InstallationIdSchema>;

export const ChannelBindingIdSchema = z.string().uuid();
export type ChannelBindingId = z.infer<typeof ChannelBindingIdSchema>;

export const PairingChallengeIdSchema = z.string().uuid();
export type PairingChallengeId = z.infer<typeof PairingChallengeIdSchema>;

export const RuntimeEventIdSchema = z.string().uuid();
export type RuntimeEventId = z.infer<typeof RuntimeEventIdSchema>;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

const ChannelSummaryNotificationUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  });

export const ChannelSummaryNotificationSchema = z
  .object({
    completed_at: IsoDateTimeSchema,
    content_id: z.string().uuid(),
    notification_id: z.string().uuid(),
    original_url: ChannelSummaryNotificationUrlSchema,
    summary: z.string().trim().min(1).max(4_000),
    title: z.string().trim().min(1).max(500),
  })
  .strict();
export type ChannelSummaryNotification = z.infer<
  typeof ChannelSummaryNotificationSchema
>;

export const ChannelSummaryNotificationPollResponseSchema = z
  .object({
    items: z.array(ChannelSummaryNotificationSchema).max(20),
    next_cursor: ChannelSummaryNotificationCursorSchema.nullable(),
  })
  .strict();
export type ChannelSummaryNotificationPollResponse = z.infer<
  typeof ChannelSummaryNotificationPollResponseSchema
>;

export const RUNTIME_PHASES = [
  "starting",
  "healthy",
  "restarting",
  "recovering_thread",
  "replaying_history",
  "degraded_auth",
  "degraded_runtime",
  "stopped",
] as const;
export const RuntimePhaseSchema = z.enum(RUNTIME_PHASES);
export type RuntimePhase = z.infer<typeof RuntimePhaseSchema>;

export const BridgeRuntimeStatusSchema = z.enum([
  "online",
  "degraded",
  "stopping",
]);
export const ILinkRuntimeStatusSchema = z.enum([
  "connected",
  "reconnecting",
  "signed_out",
]);
const RuntimeErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,99}$/u, "must be a stable error code");
const RuntimeQueueCountSchema = z.number().int().min(0).max(10_000);

export const RuntimeCheckpointReportSchema = z
  .object({
    bridge_status: BridgeRuntimeStatusSchema,
    ilink_status: ILinkRuntimeStatusSchema,
    codex_phase: RuntimePhaseSchema,
    last_healthy_at: IsoDateTimeSchema.nullable(),
    last_successful_message_at: IsoDateTimeSchema.nullable(),
    last_error_code: RuntimeErrorCodeSchema.nullable(),
    pending_inbound: RuntimeQueueCountSchema,
    pending_outbound: RuntimeQueueCountSchema,
  })
  .strict();
export type RuntimeCheckpointReport = z.infer<
  typeof RuntimeCheckpointReportSchema
>;

/**
 * Server-visible channel identifiers are opaque digests, never provider
 * credentials or provider-issued account identifiers.
 */
export const OpaqueSha256FingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "must be a lowercase SHA-256 fingerprint");
export type OpaqueSha256Fingerprint = z.infer<
  typeof OpaqueSha256FingerprintSchema
>;

const VersionLabelSchema = z.string().trim().min(1).max(64);
const DeviceNameSchema = z.string().trim().min(1).max(100);
const PairingCodeSchema = z
  .string()
  .min(6)
  .max(12)
  .regex(/^[A-Z0-9]+$/u, "must contain only uppercase letters and digits");

export const RuntimeCapabilitiesSchema = z
  .object({
    heartbeat_mode: z.enum(["runtime", "event_driven"]),
    pairing_verification: z.literal(true),
    restricted_profile: z.boolean(),
  })
  .strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export const RegisterInstallationRequestSchema = z
  .object({
    api_version: ChannelRuntimeApiVersionSchema,
    installation_id: InstallationIdSchema,
    agent_integration_id: AgentIntegrationIdSchema,
    device_name: DeviceNameSchema,
    adapter_version: VersionLabelSchema,
    skill_version: VersionLabelSchema,
    tool_contract_version: VersionLabelSchema,
    capabilities: RuntimeCapabilitiesSchema,
  })
  .strict();
export type RegisterInstallationRequest = z.infer<
  typeof RegisterInstallationRequestSchema
>;

export const InstallationViewSchema = z
  .object({
    installation_id: InstallationIdSchema,
    agent_integration_id: AgentIntegrationIdSchema,
    owner_kind: ChannelOwnerKindSchema,
    device_name: DeviceNameSchema,
    adapter_version: VersionLabelSchema,
    skill_version: VersionLabelSchema,
    tool_contract_version: VersionLabelSchema,
    capabilities: RuntimeCapabilitiesSchema,
    status: InstallationStatusSchema,
    registered_at: IsoDateTimeSchema,
    last_seen_at: IsoDateTimeSchema.nullable(),
    runtime_checkpoint: RuntimeCheckpointReportSchema.nullable(),
    disconnected_at: IsoDateTimeSchema.nullable(),
    revoked_at: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "disconnected" && value.disconnected_at === null) {
      context.addIssue({
        code: "custom",
        message: "disconnected installations require disconnected_at",
        path: ["disconnected_at"],
      });
    }
    if (value.status === "revoked" && value.revoked_at === null) {
      context.addIssue({
        code: "custom",
        message: "revoked installations require revoked_at",
        path: ["revoked_at"],
      });
    }
    if (
      value.status !== "disconnected" &&
      value.status !== "revoked" &&
      value.disconnected_at !== null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "only disconnected or revoked installations may set disconnected_at",
        path: ["disconnected_at"],
      });
    }
    if (value.status !== "revoked" && value.revoked_at !== null) {
      context.addIssue({
        code: "custom",
        message: "only revoked installations may set revoked_at",
        path: ["revoked_at"],
      });
    }
  });
export type InstallationView = z.infer<typeof InstallationViewSchema>;

export const CreateChannelBindingRequestSchema = z
  .object({
    api_version: ChannelRuntimeApiVersionSchema,
    installation_id: InstallationIdSchema,
    provider: LocalChannelProviderSchema,
    channel_account_fingerprint: OpaqueSha256FingerprintSchema,
    channel_session_fingerprint: OpaqueSha256FingerprintSchema.optional(),
  })
  .strict();
export type CreateChannelBindingRequest = z.infer<
  typeof CreateChannelBindingRequestSchema
>;

/** A short-lived response. The pairing code must not be persisted in a view. */
export const ChannelBindingChallengeSchema = z
  .object({
    binding_id: ChannelBindingIdSchema,
    challenge_id: PairingChallengeIdSchema,
    pairing_code: PairingCodeSchema,
    issued_at: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        message: "expires_at must be later than issued_at",
        path: ["expires_at"],
      });
    }
  });
export type ChannelBindingChallenge = z.infer<
  typeof ChannelBindingChallengeSchema
>;

export const ChannelBindingViewSchema = z
  .object({
    binding_id: ChannelBindingIdSchema,
    installation_id: InstallationIdSchema,
    provider: LocalChannelProviderSchema,
    channel_account_fingerprint: OpaqueSha256FingerprintSchema,
    paired_peer_fingerprint: OpaqueSha256FingerprintSchema.nullable(),
    status: ChannelBindingStatusSchema,
    created_at: IsoDateTimeSchema,
    verified_at: IsoDateTimeSchema.nullable(),
    last_seen_at: IsoDateTimeSchema.nullable(),
    disconnected_at: IsoDateTimeSchema.nullable(),
    revoked_at: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const endToEndVerified = ["verified", "healthy", "stale"].includes(
      value.status,
    );
    if (
      endToEndVerified &&
      (value.verified_at === null || value.paired_peer_fingerprint === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "verified bindings require verified_at and paired_peer_fingerprint",
        path: ["verified_at"],
      });
    }
    if (
      value.status === "reported" &&
      (value.verified_at !== null || value.paired_peer_fingerprint !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "reported bindings cannot set verified_at or paired_peer_fingerprint",
        path: ["verified_at"],
      });
    }
    if (value.status === "disconnected" && value.disconnected_at === null) {
      context.addIssue({
        code: "custom",
        message: "disconnected bindings require disconnected_at",
        path: ["disconnected_at"],
      });
    }
    if (value.status === "revoked" && value.revoked_at === null) {
      context.addIssue({
        code: "custom",
        message: "revoked bindings require revoked_at",
        path: ["revoked_at"],
      });
    }
    if (
      value.status !== "disconnected" &&
      value.status !== "revoked" &&
      value.disconnected_at !== null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "only disconnected or revoked bindings may set disconnected_at",
        path: ["disconnected_at"],
      });
    }
    if (value.status !== "revoked" && value.revoked_at !== null) {
      context.addIssue({
        code: "custom",
        message: "only revoked bindings may set revoked_at",
        path: ["revoked_at"],
      });
    }
  });
export type ChannelBindingView = z.infer<typeof ChannelBindingViewSchema>;

export const PairingVerificationReportSchema = z
  .object({
    api_version: ChannelRuntimeApiVersionSchema,
    event_id: RuntimeEventIdSchema,
    installation_id: InstallationIdSchema,
    binding_id: ChannelBindingIdSchema,
    challenge_id: PairingChallengeIdSchema,
    pairing_code: PairingCodeSchema,
    paired_peer_fingerprint: OpaqueSha256FingerprintSchema,
    observed_at: IsoDateTimeSchema,
  })
  .strict();
export type PairingVerificationReport = z.infer<
  typeof PairingVerificationReportSchema
>;

export const InstallationHeartbeatSchema = z
  .object({
    api_version: ChannelRuntimeApiVersionSchema,
    event_id: RuntimeEventIdSchema,
    installation_id: InstallationIdSchema,
    runtime_health: z.enum(["active", "degraded"]),
    runtime_checkpoint: RuntimeCheckpointReportSchema,
    observed_at: IsoDateTimeSchema,
  })
  .strict();
export type InstallationHeartbeat = z.infer<
  typeof InstallationHeartbeatSchema
>;

export const ChannelActivityReportSchema = z
  .object({
    api_version: ChannelRuntimeApiVersionSchema,
    event_id: RuntimeEventIdSchema,
    installation_id: InstallationIdSchema,
    binding_id: ChannelBindingIdSchema,
    activity: z.literal("message_processed"),
    observed_at: IsoDateTimeSchema,
  })
  .strict();
export type ChannelActivityReport = z.infer<
  typeof ChannelActivityReportSchema
>;

export const DisconnectChannelBindingRequestSchema = z
  .object({
    api_version: ChannelRuntimeApiVersionSchema,
    event_id: RuntimeEventIdSchema,
    installation_id: InstallationIdSchema,
    binding_id: ChannelBindingIdSchema,
    reason: z.enum([
      "local_requested",
      "channel_signed_out",
      "owner_switch",
      "provider_error",
    ]),
    disconnected_at: IsoDateTimeSchema,
  })
  .strict();
export type DisconnectChannelBindingRequest = z.infer<
  typeof DisconnectChannelBindingRequestSchema
>;

export const RevokeChannelBindingRequestSchema = z
  .object({
    api_version: ChannelRuntimeApiVersionSchema,
    event_id: RuntimeEventIdSchema,
    installation_id: InstallationIdSchema,
    binding_id: ChannelBindingIdSchema,
    reason: z.enum([
      "user_requested",
      "security",
      "account_revoked",
      "installation_revoked",
    ]),
    revoked_at: IsoDateTimeSchema,
  })
  .strict();
export type RevokeChannelBindingRequest = z.infer<
  typeof RevokeChannelBindingRequestSchema
>;

export const INSTALLATION_STATUS_TRANSITIONS: Readonly<
  Record<InstallationStatus, readonly InstallationStatus[]>
> = {
  registered: ["registered", "active", "disconnected", "revoked"],
  active: ["active", "degraded", "stale", "disconnected", "revoked"],
  degraded: ["degraded", "active", "stale", "disconnected", "revoked"],
  stale: ["stale", "active", "disconnected", "revoked"],
  disconnected: ["disconnected", "active", "revoked"],
  revoked: ["revoked"],
};

export const CHANNEL_BINDING_STATUS_TRANSITIONS: Readonly<
  Record<ChannelBindingStatus, readonly ChannelBindingStatus[]>
> = {
  reported: ["reported", "verified", "disconnected", "revoked"],
  verified: ["verified", "healthy", "stale", "disconnected", "revoked"],
  healthy: ["healthy", "stale", "disconnected", "revoked"],
  stale: ["stale", "healthy", "disconnected", "revoked"],
  disconnected: ["disconnected", "revoked"],
  revoked: ["revoked"],
};

export function canTransitionInstallationStatus(
  from: InstallationStatus,
  to: InstallationStatus,
): boolean {
  return INSTALLATION_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionChannelBindingStatus(
  from: ChannelBindingStatus,
  to: ChannelBindingStatus,
): boolean {
  return CHANNEL_BINDING_STATUS_TRANSITIONS[from].includes(to);
}

export const CHANNEL_PROVIDER_BY_AGENT_INTEGRATION = {
  openclaw: "wechat_ilink",
  hermes: "wechat_ilink",
  codex: "wechat_ilink",
  "claude-code": "wechat_ilink",
  workbuddy: "workbuddy_wechat",
  deepseek: "wechat_ilink",
} as const satisfies Record<AgentIntegrationId, LocalChannelProvider>;

export function isChannelProviderSupportedByAgent(
  agentIntegrationId: AgentIntegrationId,
  provider: LocalChannelProvider,
): boolean {
  return CHANNEL_PROVIDER_BY_AGENT_INTEGRATION[agentIntegrationId] === provider;
}
