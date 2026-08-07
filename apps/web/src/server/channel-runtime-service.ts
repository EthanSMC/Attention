import "server-only";

import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  ChannelBindingChallengeSchema,
  ChannelBindingViewSchema,
  InstallationViewSchema,
  getAgentIntegration,
  isChannelProviderSupportedByAgent,
  type ChannelActivityReport,
  type ChannelBindingChallenge,
  type ChannelBindingView,
  type CreateChannelBindingRequest,
  type DisconnectChannelBindingRequest,
  type InstallationHeartbeat,
  type InstallationView,
  type PairingVerificationReport,
  type RegisterInstallationRequest,
  type RuntimeCapabilities,
  type AgentIntegrationId,
} from "@attention/contracts";
import {
  agentInstallations,
  and,
  desc,
  eq,
  eventLedger,
  externalChannelBindingChallenges,
  externalChannelBindings,
  gt,
  isNull,
  sql,
  type AttentionDatabase,
  type AttentionTransaction,
} from "@attention/db";

export interface RuntimePrincipal {
  accountId: string;
  clientId: string;
}

export const CHANNEL_PAIRING_CHALLENGE_TTL_MS = 10 * 60 * 1_000;
export const MAX_RUNTIME_OBSERVED_AT_SKEW_MS = 5 * 60 * 1_000;

const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_CODE_LENGTH = 8;
const MIN_PAIRING_SECRET_LENGTH = 32;

type InstallationRow = typeof agentInstallations.$inferSelect;
type NewInstallationRow = typeof agentInstallations.$inferInsert;
type BindingRow = typeof externalChannelBindings.$inferSelect;
type ChallengeRow = typeof externalChannelBindingChallenges.$inferSelect;

export type ChannelRuntimeServiceErrorCode =
  | "binding_not_active"
  | "binding_already_bound"
  | "binding_not_found"
  | "binding_not_verifiable"
  | "capabilities_mismatch"
  | "challenge_consumed"
  | "challenge_expired"
  | "challenge_not_found"
  | "challenge_revoked"
  | "challenge_unavailable"
  | "channel_owner_conflict"
  | "event_replay_conflict"
  | "heartbeat_not_supported"
  | "installation_conflict"
  | "installation_inactive"
  | "installation_not_found"
  | "installation_revoked"
  | "invalid_principal"
  | "observed_at_out_of_range"
  | "oauth_client_conflict"
  | "pairing_code_invalid"
  | "pairing_secret_invalid"
  | "unsupported_channel_provider";

export class ChannelRuntimeServiceError extends Error {
  constructor(
    readonly code: ChannelRuntimeServiceErrorCode,
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = "ChannelRuntimeServiceError";
  }
}

export interface DerivedInstallationRegistration extends NewInstallationRow {
  accountId: string;
  capabilities: RuntimeCapabilities;
  id: string;
  oauthClientId: string;
  registeredAt: Date;
  updatedAt: Date;
}

export interface RevokeInstallationRequest {
  event_id: string;
  installation_id: string;
  reason: "account_revoked" | "security" | "user_requested";
}

export interface RevokedInstallationResult {
  installation: InstallationView;
  /** The caller may revoke this client separately; this service does not. */
  oauthClientId: string;
}

export interface ChannelRuntimeServiceOptions {
  generateId?: () => string;
  generatePairingCode?: () => string;
  now?: () => Date;
  pairingSecret: string;
}

function error(
  code: ChannelRuntimeServiceErrorCode,
  status: 400 | 404 | 409,
): never {
  throw new ChannelRuntimeServiceError(code, status);
}

function assertPrincipal(principal: RuntimePrincipal): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(principal.accountId) ||
    !principal.clientId.trim() ||
    principal.clientId.length > 128
  ) {
    error("invalid_principal", 400);
  }
}

function expectedCapabilities(
  agentIntegrationId: RegisterInstallationRequest["agent_integration_id"],
): RuntimeCapabilities {
  const integration = getAgentIntegration(agentIntegrationId);
  return {
    heartbeat_mode:
      integration.runtime_reporting.mode === "attention_runtime_oauth"
        ? "runtime"
        : "event_driven",
    pairing_verification: true,
    restricted_profile: integration.security.restricted_profile_required,
  };
}

export function isRuntimeHeartbeatSupported(
  agentIntegrationId: AgentIntegrationId,
): boolean {
  const integration = getAgentIntegration(agentIntegrationId);
  return integration.runtime_reporting.heartbeat === "runtime" &&
    integration.runtime_reporting.mode === "attention_runtime_oauth";
}

function capabilitiesEqual(
  left: RuntimeCapabilities,
  right: RuntimeCapabilities,
): boolean {
  return left.heartbeat_mode === right.heartbeat_mode &&
    left.pairing_verification === right.pairing_verification &&
    left.restricted_profile === right.restricted_profile;
}

export function deriveInstallationRegistration(input: {
  accountId: string;
  clientId: string;
  input: RegisterInstallationRequest;
  now: Date;
}): DerivedInstallationRegistration {
  const principal = { accountId: input.accountId, clientId: input.clientId };
  assertPrincipal(principal);
  const integration = getAgentIntegration(input.input.agent_integration_id);
  const capabilities = expectedCapabilities(input.input.agent_integration_id);
  if (!capabilitiesEqual(input.input.capabilities, capabilities)) {
    error("capabilities_mismatch", 400);
  }
  return {
    accountId: input.accountId,
    adapterVersion: input.input.adapter_version,
    agentIntegrationId: input.input.agent_integration_id,
    capabilities,
    deviceName: input.input.device_name,
    id: input.input.installation_id,
    oauthClientId: input.clientId,
    ownerKind: integration.channel.mode,
    registeredAt: input.now,
    skillVersion: input.input.skill_version,
    status: "registered",
    toolContractVersion: input.input.tool_contract_version,
    updatedAt: input.now,
  };
}

export function isExactInstallationReplay(
  stored: InstallationRow,
  expected: DerivedInstallationRegistration,
): boolean {
  return stored.id === expected.id &&
    stored.accountId === expected.accountId &&
    stored.oauthClientId === expected.oauthClientId &&
    stored.agentIntegrationId === expected.agentIntegrationId &&
    stored.ownerKind === expected.ownerKind &&
    stored.deviceName === expected.deviceName &&
    stored.adapterVersion === expected.adapterVersion &&
    stored.skillVersion === expected.skillVersion &&
    stored.toolContractVersion === expected.toolContractVersion &&
    capabilitiesEqual(stored.capabilities, expected.capabilities);
}

function assertPairingSecret(secret: string): void {
  if (secret.length < MIN_PAIRING_SECRET_LENGTH) {
    error("pairing_secret_invalid", 400);
  }
}

export function hashPairingChallenge(
  secret: string,
  challengeId: string,
  pairingCode: string,
): string {
  assertPairingSecret(secret);
  return createHmac("sha256", secret)
    .update(`${challengeId}:${pairingCode}`, "utf8")
    .digest("hex");
}

export function isPairingCodeMatch(
  secret: string,
  challengeId: string,
  pairingCode: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(
    hashPairingChallenge(secret, challengeId, pairingCode),
    "hex",
  );
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertObservedAtWithinSkew(
  observedAt: string,
  now: Date,
  maxSkewMs = MAX_RUNTIME_OBSERVED_AT_SKEW_MS,
): Date {
  const observed = new Date(observedAt);
  if (
    !Number.isFinite(observed.getTime()) ||
    Math.abs(observed.getTime() - now.getTime()) > maxSkewMs
  ) {
    error("observed_at_out_of_range", 400);
  }
  return observed;
}

function postgresConstraint(errorValue: unknown): string | null {
  let current = errorValue;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (candidate.code === "23505") {
      const constraint = candidate.constraint ?? candidate.constraint_name;
      return typeof constraint === "string" ? constraint : null;
    }
    current = candidate.cause;
  }
  return null;
}

export function mapChannelRuntimeDatabaseError(
  errorValue: unknown,
): ChannelRuntimeServiceError | null {
  switch (postgresConstraint(errorValue)) {
    case "agent_installations_oauth_client_unique":
      return new ChannelRuntimeServiceError("oauth_client_conflict", 409);
    case "agent_installations_pkey":
    case "agent_installations_id_account_unique":
      return new ChannelRuntimeServiceError("installation_conflict", 409);
    case "external_channel_bindings_active_owner_unique":
      return new ChannelRuntimeServiceError("channel_owner_conflict", 409);
    default:
      return null;
  }
}

function installationView(row: InstallationRow): InstallationView {
  return InstallationViewSchema.parse({
    adapter_version: row.adapterVersion,
    agent_integration_id: row.agentIntegrationId,
    capabilities: row.capabilities,
    device_name: row.deviceName,
    disconnected_at: row.disconnectedAt?.toISOString() ?? null,
    installation_id: row.id,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    owner_kind: row.ownerKind,
    registered_at: row.registeredAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
    skill_version: row.skillVersion,
    status: row.status,
    tool_contract_version: row.toolContractVersion,
  });
}

function bindingView(row: BindingRow): ChannelBindingView {
  return ChannelBindingViewSchema.parse({
    binding_id: row.id,
    channel_account_fingerprint: row.channelAccountFingerprint,
    created_at: row.createdAt.toISOString(),
    disconnected_at: row.disconnectedAt?.toISOString() ?? null,
    installation_id: row.installationId,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    paired_peer_fingerprint: row.pairedPeerFingerprint,
    provider: row.provider,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    status: row.status,
    verified_at: row.verifiedAt?.toISOString() ?? null,
  });
}

function installationPredicate(
  principal: RuntimePrincipal,
  installationId: string,
) {
  return and(
    eq(agentInstallations.id, installationId),
    eq(agentInstallations.accountId, principal.accountId),
    eq(agentInstallations.oauthClientId, principal.clientId),
  );
}

function hasPrincipalInstallation(
  principal: RuntimePrincipal,
  installationId: string,
) {
  return sql<boolean>`exists (
    select 1
      from "agent_installations" as "runtime_principal_installation"
     where "runtime_principal_installation"."id" = ${installationId}::uuid
       and "runtime_principal_installation"."account_id" = ${principal.accountId}::uuid
       and "runtime_principal_installation"."oauth_client_id" = ${principal.clientId}
  )`;
}

function bindingPredicate(
  principal: RuntimePrincipal,
  installationId: string,
  bindingId?: string,
) {
  return and(
    eq(externalChannelBindings.accountId, principal.accountId),
    eq(externalChannelBindings.installationId, installationId),
    ...(bindingId ? [eq(externalChannelBindings.id, bindingId)] : []),
    hasPrincipalInstallation(principal, installationId),
  );
}

function challengePredicate(
  principal: RuntimePrincipal,
  installationId: string,
  bindingId: string,
  challengeId?: string,
) {
  return and(
    eq(externalChannelBindingChallenges.accountId, principal.accountId),
    eq(externalChannelBindingChallenges.bindingId, bindingId),
    ...(challengeId
      ? [eq(externalChannelBindingChallenges.id, challengeId)]
      : []),
    sql<boolean>`exists (
      select 1
        from "external_channel_bindings" as "runtime_principal_binding"
        join "agent_installations" as "runtime_principal_installation"
          on "runtime_principal_installation"."id" = "runtime_principal_binding"."installation_id"
         and "runtime_principal_installation"."account_id" = "runtime_principal_binding"."account_id"
       where "runtime_principal_binding"."id" = ${bindingId}::uuid
         and "runtime_principal_binding"."installation_id" = ${installationId}::uuid
         and "runtime_principal_binding"."account_id" = ${principal.accountId}::uuid
         and "runtime_principal_installation"."oauth_client_id" = ${principal.clientId}
    )`,
  );
}

async function withPrincipalTransaction<T>(
  db: AttentionDatabase,
  principal: RuntimePrincipal,
  callback: (tx: AttentionTransaction) => Promise<T>,
): Promise<T> {
  assertPrincipal(principal);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.account_id', ${principal.accountId}, true)`,
    );
    return callback(tx);
  });
}

async function principalInstallation(
  tx: AttentionTransaction,
  principal: RuntimePrincipal,
  installationId: string,
  lock = false,
): Promise<InstallationRow | null> {
  const query = tx
    .select()
    .from(agentInstallations)
    .where(installationPredicate(principal, installationId));
  const rows = lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  return rows[0] ?? null;
}

function assertInstallationUsable(
  row: InstallationRow | null,
  options: { allowDisconnected?: boolean } = {},
): asserts row is InstallationRow {
  if (!row) error("installation_not_found", 404);
  if (row.status === "revoked") error("installation_revoked", 409);
  if (row.status === "disconnected" && !options.allowDisconnected) {
    error("installation_inactive", 409);
  }
}

async function scopedBinding(
  tx: AttentionTransaction,
  principal: RuntimePrincipal,
  installationId: string,
  bindingId: string,
  lock = false,
): Promise<BindingRow | null> {
  const query = tx
    .select()
    .from(externalChannelBindings)
    .where(bindingPredicate(principal, installationId, bindingId));
  const rows = lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  return rows[0] ?? null;
}

type RuntimeEventType =
  | "agent.installation.heartbeat.v1"
  | "agent.installation.registered.v1"
  | "agent.installation.revoked.v1"
  | "channel.binding.activity.v1"
  | "channel.binding.disconnected.v1"
  | "channel.binding.reported.v1"
  | "channel.binding.verified.v1";

interface RuntimeEventInput {
  accountId: string;
  dedupeKey: string;
  eventType: RuntimeEventType;
  metadata: Record<string, string>;
  now: Date;
  requestId: string;
}

export function isExactRuntimeEventReplay(
  existing: {
    eventType: string;
    metadata: Record<string, unknown>;
    requestId: string | null;
  },
  expected: RuntimeEventInput,
): boolean {
  const existingKeys = Object.keys(existing.metadata).sort();
  const expectedKeys = Object.keys(expected.metadata).sort();
  return existing.eventType === expected.eventType &&
    existing.requestId === expected.requestId &&
    existingKeys.length === expectedKeys.length &&
    existingKeys.every((key, index) =>
      key === expectedKeys[index] &&
      existing.metadata[key] === expected.metadata[key]
    );
}

async function appendRuntimeEvent(
  tx: AttentionTransaction,
  input: RuntimeEventInput,
): Promise<boolean> {
  const inserted = await tx
    .insert(eventLedger)
    .values({
      accountId: input.accountId,
      dedupeKey: input.dedupeKey,
      eventType: input.eventType,
      metadata: input.metadata,
      occurredAt: input.now,
      requestId: input.requestId,
      scope: "private",
    })
    .onConflictDoNothing({ target: eventLedger.dedupeKey })
    .returning({ id: eventLedger.id });
  if (inserted.length > 0) return true;

  const [existing] = await tx
    .select({
      eventType: eventLedger.eventType,
      metadata: eventLedger.metadata,
      requestId: eventLedger.requestId,
    })
    .from(eventLedger)
    .where(and(
      eq(eventLedger.accountId, input.accountId),
      eq(eventLedger.dedupeKey, input.dedupeKey),
      eq(eventLedger.scope, "private"),
    ))
    .limit(1);
  if (!existing || !isExactRuntimeEventReplay(existing, input)) {
    error("event_replay_conflict", 409);
  }
  return false;
}

function eventDedupeKey(
  principal: RuntimePrincipal,
  eventId: string,
): string {
  return `channel-runtime:${principal.accountId}:${principal.clientId}:${eventId}`;
}

function defaultPairingCode(): string {
  const random = randomBytes(PAIRING_CODE_LENGTH);
  let code = "";
  for (const value of random) {
    code += PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

function assertGeneratedPairingCode(code: string): void {
  if (!/^[A-Z0-9]{6,12}$/u.test(code)) {
    error("pairing_code_invalid", 400);
  }
}

export class ChannelRuntimeService {
  readonly #db: AttentionDatabase;
  readonly #generateId: () => string;
  readonly #generatePairingCode: () => string;
  readonly #now: () => Date;
  readonly #pairingSecret: string;

  constructor(db: AttentionDatabase, options: ChannelRuntimeServiceOptions) {
    assertPairingSecret(options.pairingSecret);
    this.#db = db;
    this.#generateId = options.generateId ?? randomUUID;
    this.#generatePairingCode = options.generatePairingCode ?? defaultPairingCode;
    this.#now = options.now ?? (() => new Date());
    this.#pairingSecret = options.pairingSecret;
  }

  async registerInstallation(
    principal: RuntimePrincipal,
    input: RegisterInstallationRequest,
  ): Promise<InstallationView> {
    const now = this.#now();
    const registration = deriveInstallationRegistration({
      accountId: principal.accountId,
      clientId: principal.clientId,
      input,
      now,
    });
    try {
      return await withPrincipalTransaction(this.#db, principal, async (tx) => {
        const [existing] = await tx
          .select()
          .from(agentInstallations)
          .where(and(
            eq(agentInstallations.id, registration.id),
            eq(agentInstallations.accountId, registration.accountId),
          ))
          .for("update")
          .limit(1);
        if (existing) {
          if (!isExactInstallationReplay(existing, registration)) {
            error("installation_conflict", 409);
          }
          return installationView(existing);
        }

        const [inserted] = await tx
          .insert(agentInstallations)
          .values(registration)
          .returning();
        if (!inserted) throw new Error("installation_insert_failed");
        await appendRuntimeEvent(tx, {
          accountId: principal.accountId,
          dedupeKey: eventDedupeKey(principal, input.installation_id),
          eventType: "agent.installation.registered.v1",
          metadata: {
            agent_integration_id: inserted.agentIntegrationId,
            installation_id: inserted.id,
            owner_kind: inserted.ownerKind,
          },
          now,
          requestId: input.installation_id,
        });
        return installationView(inserted);
      });
    } catch (caught) {
      const mapped = mapChannelRuntimeDatabaseError(caught);
      if (
        mapped?.code === "installation_conflict" ||
        mapped?.code === "oauth_client_conflict"
      ) {
        const replay = await withPrincipalTransaction(
          this.#db,
          principal,
          async (tx) => {
            const [existing] = await tx
              .select()
              .from(agentInstallations)
              .where(and(
                eq(agentInstallations.id, registration.id),
                eq(agentInstallations.accountId, registration.accountId),
              ))
              .limit(1);
            return existing && isExactInstallationReplay(existing, registration)
              ? installationView(existing)
              : null;
          },
        );
        if (replay) return replay;
      }
      if (mapped) throw mapped;
      throw caught;
    }
  }

  async getInstallation(
    principal: RuntimePrincipal,
    installationId: string,
  ): Promise<InstallationView> {
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const installation = await principalInstallation(
        tx,
        principal,
        installationId,
      );
      if (!installation) error("installation_not_found", 404);
      return installationView(installation);
    });
  }

  async listInstallations(
    principal: RuntimePrincipal,
  ): Promise<InstallationView[]> {
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const rows = await tx
        .select()
        .from(agentInstallations)
        .where(and(
          eq(agentInstallations.accountId, principal.accountId),
          eq(agentInstallations.oauthClientId, principal.clientId),
        ))
        .orderBy(desc(agentInstallations.registeredAt));
      return rows.map(installationView);
    });
  }

  async createChannelBinding(
    principal: RuntimePrincipal,
    input: CreateChannelBindingRequest,
  ): Promise<ChannelBindingChallenge> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + CHANNEL_PAIRING_CHALLENGE_TTL_MS);
    try {
      return await withPrincipalTransaction(this.#db, principal, async (tx) => {
        const installation = await principalInstallation(
          tx,
          principal,
          input.installation_id,
          true,
        );
        assertInstallationUsable(installation);
        if (!isChannelProviderSupportedByAgent(
          installation.agentIntegrationId,
          input.provider,
        )) {
          error("unsupported_channel_provider", 400);
        }

        const [existing] = await tx
          .select()
          .from(externalChannelBindings)
          .where(and(
            bindingPredicate(principal, input.installation_id),
            eq(externalChannelBindings.provider, input.provider),
            eq(
              externalChannelBindings.channelAccountFingerprint,
              input.channel_account_fingerprint,
            ),
            sql`${externalChannelBindings.status} in ('reported', 'verified', 'healthy', 'stale')`,
          ))
          .for("update")
          .limit(1);
        if (existing && existing.status !== "reported") {
          error("binding_already_bound", 409);
        }

        const pairingCode = this.#generatePairingCode();
        assertGeneratedPairingCode(pairingCode);
        const challengeId = this.#generateId();
        let binding = existing;
        if (!binding) {
          const [created] = await tx
            .insert(externalChannelBindings)
            .values({
              accountId: principal.accountId,
              channelAccountFingerprint: input.channel_account_fingerprint,
              createdAt: now,
              id: this.#generateId(),
              installationId: input.installation_id,
              provider: input.provider,
              status: "reported",
              updatedAt: now,
            })
            .returning();
          if (!created) throw new Error("binding_insert_failed");
          binding = created;
        }

        await tx
          .update(externalChannelBindingChallenges)
          .set({ revokedAt: now })
          .where(and(
            challengePredicate(
              principal,
              input.installation_id,
              binding.id,
            ),
            isNull(externalChannelBindingChallenges.consumedAt),
            isNull(externalChannelBindingChallenges.revokedAt),
          ));
        await tx.insert(externalChannelBindingChallenges).values({
          accountId: principal.accountId,
          bindingId: binding.id,
          expiresAt,
          id: challengeId,
          issuedAt: now,
          pairingCodeHash: hashPairingChallenge(
            this.#pairingSecret,
            challengeId,
            pairingCode,
          ),
        });
        await appendRuntimeEvent(tx, {
          accountId: principal.accountId,
          dedupeKey: eventDedupeKey(principal, challengeId),
          eventType: "channel.binding.reported.v1",
          metadata: {
            binding_id: binding.id,
            installation_id: input.installation_id,
            provider: input.provider,
          },
          now,
          requestId: challengeId,
        });
        return ChannelBindingChallengeSchema.parse({
          binding_id: binding.id,
          challenge_id: challengeId,
          expires_at: expiresAt.toISOString(),
          issued_at: now.toISOString(),
          pairing_code: pairingCode,
        });
      });
    } catch (caught) {
      const mapped = mapChannelRuntimeDatabaseError(caught);
      if (mapped) throw mapped;
      throw caught;
    }
  }

  async getChannelBinding(
    principal: RuntimePrincipal,
    installationId: string,
    bindingId: string,
  ): Promise<ChannelBindingView> {
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const binding = await scopedBinding(
        tx,
        principal,
        installationId,
        bindingId,
      );
      if (!binding) error("binding_not_found", 404);
      return bindingView(binding);
    });
  }

  async listChannelBindings(
    principal: RuntimePrincipal,
    installationId: string,
  ): Promise<ChannelBindingView[]> {
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const installation = await principalInstallation(
        tx,
        principal,
        installationId,
      );
      if (!installation) error("installation_not_found", 404);
      const rows = await tx
        .select()
        .from(externalChannelBindings)
        .where(bindingPredicate(principal, installationId))
        .orderBy(desc(externalChannelBindings.createdAt));
      return rows.map(bindingView);
    });
  }

  async verifyPairing(
    principal: RuntimePrincipal,
    input: PairingVerificationReport,
  ): Promise<ChannelBindingView> {
    const now = this.#now();
    assertObservedAtWithinSkew(
      input.observed_at,
      now,
      CHANNEL_PAIRING_CHALLENGE_TTL_MS,
    );
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const insertedEvent = await appendRuntimeEvent(tx, {
        accountId: principal.accountId,
        dedupeKey: eventDedupeKey(principal, input.event_id),
        eventType: "channel.binding.verified.v1",
        metadata: {
          binding_id: input.binding_id,
          challenge_id: input.challenge_id,
          installation_id: input.installation_id,
          paired_peer_fingerprint: input.paired_peer_fingerprint,
        },
        now,
        requestId: input.event_id,
      });
      if (!insertedEvent) {
        const replay = await scopedBinding(
          tx,
          principal,
          input.installation_id,
          input.binding_id,
        );
        if (!replay) error("binding_not_found", 404);
        return bindingView(replay);
      }

      const installation = await principalInstallation(
        tx,
        principal,
        input.installation_id,
        true,
      );
      assertInstallationUsable(installation);
      const binding = await scopedBinding(
        tx,
        principal,
        input.installation_id,
        input.binding_id,
        true,
      );
      if (!binding) error("binding_not_found", 404);
      if (binding.status !== "reported") error("binding_not_verifiable", 409);

      const [challenge] = await tx
        .select()
        .from(externalChannelBindingChallenges)
        .where(challengePredicate(
          principal,
          input.installation_id,
          input.binding_id,
          input.challenge_id,
        ))
        .for("update")
        .limit(1);
      const usableChallenge = challenge ?? null;
      this.#assertChallengeUsable(usableChallenge, now);
      if (!isPairingCodeMatch(
        this.#pairingSecret,
        usableChallenge.id,
        input.pairing_code,
        usableChallenge.pairingCodeHash,
      )) {
        error("pairing_code_invalid", 400);
      }

      const consumed = await tx
        .update(externalChannelBindingChallenges)
        .set({ consumedAt: now })
        .where(and(
          challengePredicate(
            principal,
            input.installation_id,
            input.binding_id,
            input.challenge_id,
          ),
          isNull(externalChannelBindingChallenges.consumedAt),
          isNull(externalChannelBindingChallenges.revokedAt),
          gt(externalChannelBindingChallenges.expiresAt, now),
        ))
        .returning({ id: externalChannelBindingChallenges.id });
      if (consumed.length === 0) error("challenge_unavailable", 409);

      const [updated] = await tx
        .update(externalChannelBindings)
        .set({
          lastSeenAt: now,
          pairedPeerFingerprint: input.paired_peer_fingerprint,
          status: "verified",
          updatedAt: now,
          verifiedAt: now,
        })
        .where(and(
          bindingPredicate(
            principal,
            input.installation_id,
            input.binding_id,
          ),
          eq(externalChannelBindings.status, "reported"),
        ))
        .returning();
      if (!updated) error("binding_not_verifiable", 409);
      return bindingView(updated);
    });
  }

  async recordInstallationHeartbeat(
    principal: RuntimePrincipal,
    input: InstallationHeartbeat,
  ): Promise<InstallationView> {
    const now = this.#now();
    assertObservedAtWithinSkew(input.observed_at, now);
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const installation = await principalInstallation(
        tx,
        principal,
        input.installation_id,
        true,
      );
      assertInstallationUsable(installation, { allowDisconnected: true });
      if (!isRuntimeHeartbeatSupported(installation.agentIntegrationId)) {
        error("heartbeat_not_supported", 409);
      }
      const insertedEvent = await appendRuntimeEvent(tx, {
        accountId: principal.accountId,
        dedupeKey: eventDedupeKey(principal, input.event_id),
        eventType: "agent.installation.heartbeat.v1",
        metadata: {
          installation_id: input.installation_id,
          runtime_health: input.runtime_health,
        },
        now,
        requestId: input.event_id,
      });
      if (!insertedEvent) {
        return installationView(installation);
      }
      const [updated] = await tx
        .update(agentInstallations)
        .set({
          disconnectedAt: null,
          lastSeenAt: now,
          status: input.runtime_health,
          updatedAt: now,
        })
        .where(installationPredicate(principal, input.installation_id))
        .returning();
      if (!updated) error("installation_not_found", 404);
      return installationView(updated);
    });
  }

  async recordChannelActivity(
    principal: RuntimePrincipal,
    input: ChannelActivityReport,
  ): Promise<ChannelBindingView> {
    const now = this.#now();
    assertObservedAtWithinSkew(input.observed_at, now);
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const insertedEvent = await appendRuntimeEvent(tx, {
        accountId: principal.accountId,
        dedupeKey: eventDedupeKey(principal, input.event_id),
        eventType: "channel.binding.activity.v1",
        metadata: {
          activity: input.activity,
          binding_id: input.binding_id,
          installation_id: input.installation_id,
        },
        now,
        requestId: input.event_id,
      });
      if (!insertedEvent) {
        const replay = await scopedBinding(
          tx,
          principal,
          input.installation_id,
          input.binding_id,
        );
        if (!replay) error("binding_not_found", 404);
        return bindingView(replay);
      }
      const installation = await principalInstallation(
        tx,
        principal,
        input.installation_id,
        true,
      );
      assertInstallationUsable(installation);
      const binding = await scopedBinding(
        tx,
        principal,
        input.installation_id,
        input.binding_id,
        true,
      );
      if (!binding) error("binding_not_found", 404);
      if (!(["verified", "healthy", "stale"] as const).includes(
        binding.status as "healthy" | "stale" | "verified",
      )) {
        error("binding_not_active", 409);
      }
      const [updated] = await tx
        .update(externalChannelBindings)
        .set({ lastSeenAt: now, status: "healthy", updatedAt: now })
        .where(bindingPredicate(
          principal,
          input.installation_id,
          input.binding_id,
        ))
        .returning();
      if (!updated) error("binding_not_found", 404);
      return bindingView(updated);
    });
  }

  async disconnectChannelBinding(
    principal: RuntimePrincipal,
    input: DisconnectChannelBindingRequest,
  ): Promise<ChannelBindingView> {
    const now = this.#now();
    assertObservedAtWithinSkew(input.disconnected_at, now);
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const insertedEvent = await appendRuntimeEvent(tx, {
        accountId: principal.accountId,
        dedupeKey: eventDedupeKey(principal, input.event_id),
        eventType: "channel.binding.disconnected.v1",
        metadata: {
          binding_id: input.binding_id,
          installation_id: input.installation_id,
          reason: input.reason,
        },
        now,
        requestId: input.event_id,
      });
      if (!insertedEvent) {
        const replay = await scopedBinding(
          tx,
          principal,
          input.installation_id,
          input.binding_id,
        );
        if (!replay) error("binding_not_found", 404);
        return bindingView(replay);
      }
      const installation = await principalInstallation(
        tx,
        principal,
        input.installation_id,
        true,
      );
      assertInstallationUsable(installation, { allowDisconnected: true });
      const binding = await scopedBinding(
        tx,
        principal,
        input.installation_id,
        input.binding_id,
        true,
      );
      if (!binding) error("binding_not_found", 404);
      if (binding.status === "revoked") error("binding_not_active", 409);
      if (binding.status === "disconnected") return bindingView(binding);

      const [updated] = await tx
        .update(externalChannelBindings)
        .set({ disconnectedAt: now, status: "disconnected", updatedAt: now })
        .where(bindingPredicate(
          principal,
          input.installation_id,
          input.binding_id,
        ))
        .returning();
      if (!updated) error("binding_not_found", 404);
      await tx
        .update(externalChannelBindingChallenges)
        .set({ revokedAt: now })
        .where(and(
          challengePredicate(
            principal,
            input.installation_id,
            input.binding_id,
          ),
          isNull(externalChannelBindingChallenges.consumedAt),
          isNull(externalChannelBindingChallenges.revokedAt),
        ));
      return bindingView(updated);
    });
  }

  async revokeInstallation(
    principal: RuntimePrincipal,
    input: RevokeInstallationRequest,
  ): Promise<RevokedInstallationResult> {
    const now = this.#now();
    return withPrincipalTransaction(this.#db, principal, async (tx) => {
      const insertedEvent = await appendRuntimeEvent(tx, {
        accountId: principal.accountId,
        dedupeKey: eventDedupeKey(principal, input.event_id),
        eventType: "agent.installation.revoked.v1",
        metadata: {
          installation_id: input.installation_id,
          reason: input.reason,
        },
        now,
        requestId: input.event_id,
      });
      const installation = await principalInstallation(
        tx,
        principal,
        input.installation_id,
        true,
      );
      if (!installation) error("installation_not_found", 404);
      if (!insertedEvent || installation.status === "revoked") {
        return {
          installation: installationView(installation),
          oauthClientId: installation.oauthClientId,
        };
      }

      await tx
        .update(externalChannelBindingChallenges)
        .set({ revokedAt: now })
        .where(and(
          eq(
            externalChannelBindingChallenges.accountId,
            principal.accountId,
          ),
          isNull(externalChannelBindingChallenges.consumedAt),
          isNull(externalChannelBindingChallenges.revokedAt),
          sql<boolean>`exists (
            select 1
              from "external_channel_bindings" as "runtime_revoke_binding"
             where "runtime_revoke_binding"."id" = ${externalChannelBindingChallenges.bindingId}
               and "runtime_revoke_binding"."installation_id" = ${input.installation_id}::uuid
               and "runtime_revoke_binding"."account_id" = ${principal.accountId}::uuid
          )`,
          hasPrincipalInstallation(principal, input.installation_id),
        ));
      await tx
        .update(externalChannelBindings)
        .set({ revokedAt: now, status: "revoked", updatedAt: now })
        .where(bindingPredicate(principal, input.installation_id));
      const [updated] = await tx
        .update(agentInstallations)
        .set({ revokedAt: now, status: "revoked", updatedAt: now })
        .where(installationPredicate(principal, input.installation_id))
        .returning();
      if (!updated) error("installation_not_found", 404);
      return {
        installation: installationView(updated),
        oauthClientId: updated.oauthClientId,
      };
    });
  }

  #assertChallengeUsable(
    challenge: ChallengeRow | null,
    now: Date,
  ): asserts challenge is ChallengeRow {
    if (!challenge) error("challenge_not_found", 404);
    if (challenge.consumedAt) error("challenge_consumed", 409);
    if (challenge.revokedAt) error("challenge_revoked", 409);
    if (challenge.expiresAt <= now) error("challenge_expired", 409);
  }
}

export function createChannelRuntimeService(
  db: AttentionDatabase,
  options: ChannelRuntimeServiceOptions,
): ChannelRuntimeService {
  return new ChannelRuntimeService(db, options);
}
