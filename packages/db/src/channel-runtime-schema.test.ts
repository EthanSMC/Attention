import {
  CHANNEL_BINDING_STATUSES,
  INSTALLATION_STATUSES,
  LOCAL_CHANNEL_PROVIDERS
} from "@attention/contracts";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  agentInstallations,
  externalChannelBindingChallenges,
  externalChannelBindings,
  externalChannelBindingStatusEnum,
  eventLedger,
  installationStatusEnum,
  localChannelProviderEnum
} from "./schema";

const configFor = (table: PgTable) => getTableConfig(table);

describe("local channel runtime database schema", () => {
  it("keeps the persisted enums aligned with the public runtime contract", () => {
    expect(installationStatusEnum.enumValues).toEqual(INSTALLATION_STATUSES);
    expect(externalChannelBindingStatusEnum.enumValues).toEqual(CHANNEL_BINDING_STATUSES);
    expect(localChannelProviderEnum.enumValues).toEqual(LOCAL_CHANNEL_PROVIDERS);
  });

  it("uses account-scoped RLS on installations, bindings, and challenges", () => {
    for (const table of [
      agentInstallations,
      externalChannelBindings,
      externalChannelBindingChallenges
    ]) {
      const config = configFor(table);
      expect(config.enableRLS).toBe(true);
      expect(config.columns.find((column) => column.name === "account_id")?.notNull).toBe(true);
      expect(config.policies).toHaveLength(1);
      expect(config.policies[0]).toMatchObject({
        for: "all",
        to: "attention_web_runtime"
      });
    }
  });

  it("binds child rows to the same account as their parent", () => {
    const bindingForeignKey = configFor(externalChannelBindings).foreignKeys.find(
      (foreignKey) => foreignKey.getName() === "external_channel_bindings_installation_account_fk"
    );
    const challengeForeignKey = configFor(externalChannelBindingChallenges).foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() ===
        "external_channel_binding_challenges_binding_account_fk"
    );

    expect(bindingForeignKey?.reference().columns.map((column) => column.name)).toEqual([
      "installation_id",
      "account_id"
    ]);
    expect(bindingForeignKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "id",
      "account_id"
    ]);
    expect(challengeForeignKey?.reference().columns.map((column) => column.name)).toEqual([
      "binding_id",
      "account_id"
    ]);
    expect(challengeForeignKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "id",
      "account_id"
    ]);
  });

  it("keeps one OAuth client per installation and one active owner per channel", () => {
    const installationConfig = configFor(agentInstallations);
    const installationIndexes = installationConfig.indexes;
    const bindingIndexes = configFor(externalChannelBindings).indexes;
    const oauthClientForeignKey = installationConfig.foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() ===
        "agent_installations_oauth_client_id_oauth_clients_client_id_fk"
    );

    expect(agentInstallations.oauthClientId.notNull).toBe(true);
    expect(oauthClientForeignKey?.reference().columns.map((column) => column.name)).toEqual([
      "oauth_client_id"
    ]);
    expect(oauthClientForeignKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "client_id"
    ]);
    expect(
      installationIndexes.find(
        (index) => index.config.name === "agent_installations_oauth_client_unique"
      )
    ).toMatchObject({ config: { unique: true } });
    expect(
      bindingIndexes.find(
        (index) => index.config.name === "external_channel_bindings_active_owner_unique"
      )
    ).toMatchObject({ config: { unique: true } });
    expect(
      bindingIndexes.find(
        (index) => index.config.name === "external_channel_bindings_active_owner_unique"
      )?.config.where
    ).toBeDefined();
    expect(
      bindingIndexes
        .find((index) => index.config.name === "external_channel_bindings_active_owner_unique")
        ?.config.columns.map((column) => "name" in column ? column.name : undefined)
    ).toEqual(["provider", "channel_account_fingerprint"]);
    expect(
      bindingIndexes
        .find((index) => index.config.name === "external_channel_bindings_session_lookup_idx")
        ?.config.columns.map((column) => "name" in column ? column.name : undefined)
    ).toEqual([
      "provider",
      "channel_account_fingerprint",
      "channel_session_fingerprint"
    ]);
  });

  it("defines status, fingerprint, and short-lived challenge constraints", () => {
    expect(configFor(agentInstallations).checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "agent_installations_owner_kind_matches_agent",
        "agent_installations_capabilities_shape",
        "agent_installations_terminal_status_shape",
        "agent_installations_timestamp_order"
      ])
    );
    expect(configFor(externalChannelBindings).checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "external_channel_bindings_channel_fingerprint_format",
        "external_channel_bindings_session_fingerprint_format",
        "external_channel_bindings_peer_fingerprint_format",
        "external_channel_bindings_verification_shape",
        "external_channel_bindings_terminal_status_shape",
        "external_channel_bindings_timestamp_order"
      ])
    );
    expect(
      configFor(externalChannelBindingChallenges).checks.map(
        (constraint) => constraint.name
      )
    ).toEqual(
      expect.arrayContaining([
        "external_channel_binding_challenges_code_hash_format",
        "external_channel_binding_challenges_valid_window",
        "external_channel_binding_challenges_terminal_shape"
      ])
    );
  });

  it("stores only fixed-length opaque digests for channel and pairing identifiers", () => {
    expect(externalChannelBindings.channelAccountFingerprint.getSQLType()).toBe("char(64)");
    expect(externalChannelBindings.channelSessionFingerprint.getSQLType()).toBe("char(64)");
    expect(externalChannelBindings.channelSessionFingerprint.notNull).toBe(false);
    expect(externalChannelBindings.pairedPeerFingerprint.getSQLType()).toBe("char(64)");
    expect(externalChannelBindingChallenges.pairingCodeHash.getSQLType()).toBe("char(64)");

    const allColumnNames = [
      ...configFor(agentInstallations).columns,
      ...configFor(externalChannelBindings).columns,
      ...configFor(externalChannelBindingChallenges).columns
    ].map((column) => column.name);
    expect(allColumnNames).not.toEqual(
      expect.arrayContaining([
        "bot_token",
        "context_token",
        "sync_cursor",
        "message_id",
        "pairing_code",
        "qr_code"
      ])
    );
  });

  it("stores a nullable privacy-safe runtime checkpoint object", () => {
    const installationConfig = configFor(agentInstallations);
    const runtimeCheckpoint = installationConfig.columns.find(
      (column) => column.name === "runtime_checkpoint"
    );
    const runtimeCheckpointConstraint = installationConfig.checks.find(
      (constraint) =>
        constraint.name === "agent_installations_runtime_checkpoint_shape"
    );
    const predicate = new PgDialect().sqlToQuery(
      runtimeCheckpointConstraint!.value
    ).sql;

    expect(runtimeCheckpoint?.getSQLType()).toBe("jsonb");
    expect(runtimeCheckpoint?.notNull).toBe(false);
    expect(predicate).toContain("jsonb_typeof");
    expect(predicate).toContain("'object'");
    for (const forbidden of ["token", "thread_id", "message", "url", "reply"]) {
      expect(predicate).toContain(`'${forbidden}'`);
    }
  });

  it("allows only the narrow runtime lifecycle audit envelope", () => {
    const policies = configFor(eventLedger).policies;
    const toolPolicy = policies.find(
      (policy) => policy.name === "event_ledger_web_tool_audit_insert"
    );
    const runtimePolicy = policies.find(
      (policy) => policy.name === "event_ledger_web_runtime_lifecycle_insert"
    );
    const replayPolicy = policies.find(
      (policy) => policy.name === "event_ledger_web_runtime_lifecycle_replay_read"
    );
    const dialect = new PgDialect();
    const toolPredicate = dialect.sqlToQuery(toolPolicy!.withCheck!).sql;
    const runtimePredicate = dialect.sqlToQuery(runtimePolicy!.withCheck!).sql;
    const replayPredicate = dialect.sqlToQuery(replayPolicy!.using!).sql;

    expect(toolPredicate).toContain("event_type\" = 'agent.tool_call.v1'");
    expect(toolPredicate).toContain("dedupe_key\" IS NULL");
    expect(runtimePolicy).toMatchObject({
      for: "insert",
      to: "attention_web_runtime"
    });
    for (const eventType of [
      "agent.installation.registered.v1",
      "agent.installation.heartbeat.v1",
      "agent.installation.revoked.v1",
      "channel.binding.reported.v1",
      "channel.binding.replaced.v1",
      "channel.binding.verified.v1",
      "channel.binding.activity.v1",
      "channel.binding.disconnected.v1"
    ]) {
      expect(runtimePredicate).toContain(`'${eventType}'`);
    }
    expect(runtimePredicate).toContain("account_id\" = NULLIF(current_setting('app.account_id', true), '')::uuid");
    expect(runtimePredicate).toContain("scope\" = 'private'");
    expect(runtimePredicate).toContain("content_id\" IS NULL");
    expect(runtimePredicate).toContain("anonymous_session_id\" IS NULL");
    expect(runtimePredicate).toContain("request_id\" IS NOT NULL");
    expect(runtimePredicate).not.toContain("dedupe_key");
    expect(replayPolicy).toMatchObject({
      for: "select",
      to: "attention_web_runtime",
      withCheck: undefined
    });
    expect(replayPredicate).toContain("account_id\" = NULLIF(current_setting('app.account_id', true), '')::uuid");
    expect(replayPredicate).toContain("scope\" = 'private'");
    expect(replayPredicate).toContain("content_id\" IS NULL");
    expect(replayPredicate).toContain("anonymous_session_id\" IS NULL");
    expect(replayPredicate).toContain("request_id\" IS NOT NULL");
    expect(replayPredicate).toContain("dedupe_key\" IS NOT NULL");
    expect(replayPredicate).not.toContain("agent.tool_call.v1");
    for (const eventType of [
      "agent.installation.registered.v1",
      "agent.installation.heartbeat.v1",
      "agent.installation.revoked.v1",
      "channel.binding.reported.v1",
      "channel.binding.replaced.v1",
      "channel.binding.verified.v1",
      "channel.binding.activity.v1",
      "channel.binding.disconnected.v1"
    ]) {
      expect(replayPredicate).toContain(`'${eventType}'`);
    }
  });
});
