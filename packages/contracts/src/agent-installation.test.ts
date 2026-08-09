import { describe, expect, it } from "vitest";

import { AGENT_INTEGRATION_IDS } from "./agent-integration";
import {
  AGENT_COMMAND_TEMPLATE_PLACEHOLDERS,
  AGENT_INSTALLATION_MANIFEST_SCHEMA_VERSION,
  ATTENTION_RESTRICTED_PROFILE_PUBLIC_PATH,
  ATTENTION_SKILL_DOCUMENT_SHA256,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
  AgentInstallationCatalogSchema,
  AgentInstallationProfileSchema,
  RestrictedAgentProfileTemplateSchema,
  agentInstallationCatalog,
  agentInstallationProfiles,
  getAgentInstallationProfile,
  restrictedAgentProfileTemplate,
} from "./agent-installation";
import { CHANNEL_RUNTIME_SCOPES } from "./channel-runtime";

describe("Agent installation manifests", () => {
  it("publishes a versioned infrastructure-only catalog for all v1 hosts", () => {
    expect(() =>
      AgentInstallationCatalogSchema.parse(agentInstallationCatalog),
    ).not.toThrow();
    expect(agentInstallationCatalog).toMatchObject({
      boundaries: {
        hosted_agent: false,
        hosted_channel_ui: false,
        local_channel_credentials_uploaded: false,
      },
      command_placeholders: AGENT_COMMAND_TEMPLATE_PLACEHOLDERS,
      migration: {
        from_schema: "2.2.0",
        guide_anchor: "#schema-23-migration",
      },
      release_stage: "infrastructure_only",
      schema_version: AGENT_INSTALLATION_MANIFEST_SCHEMA_VERSION,
    });
    expect(agentInstallationCatalog.integrations.map(({ id }) => id)).toEqual(
      AGENT_INTEGRATION_IDS,
    );
    expect(agentInstallationCatalog.skill.document_sha256).toBe(
      ATTENTION_SKILL_DOCUMENT_SHA256,
    );
    expect(
      agentInstallationProfiles.every(
        (profile) =>
          profile.skill.document_sha256 === ATTENTION_SKILL_DOCUMENT_SHA256,
      ),
    ).toBe(true);
    expect(
      agentInstallationProfiles.every(
        (profile) =>
          profile.acceptance.tool_name === "attention_get_my_account" &&
          profile.acceptance.requirement === "successful_tool_result" &&
          !profile.acceptance.config_probe_is_acceptance,
      ),
    ).toBe(true);
  });

  it("uses argv command templates that can run without a shell", () => {
    for (const profile of agentInstallationProfiles) {
      const commands = [
        profile.mcp.add_command_template,
        profile.mcp.login_command_template,
        profile.mcp.probe_command_template,
        profile.skill.install_command_template,
        ...profile.channel.setup_command_templates,
      ].filter((command) => command !== null);
      for (const command of commands) {
        expect(command.executable).not.toMatch(/\s/u);
        expect(command.args.every((argument) => argument.length > 0)).toBe(true);
      }
    }
  });

  it("publishes truthful native host commands and sources", () => {
    expect(getAgentInstallationProfile("openclaw")).toMatchObject({
      channel: {
        availability: "available_external",
        minimum_version: "2026.5.12",
        package_ref: "@tencent-weixin/openclaw-weixin@2.4.6",
      },
      compatibility: {
        minimum_version: "2026.5.12",
        policy: "pinned",
      },
      mcp: {
        add_command_template: {
          executable: "openclaw",
        },
      },
      skill: {
        delivery: "host_import_directory",
        install: "filesystem_directory",
        local_path: {
          entrypoint: "SKILL.md",
          posix_directory: "./attention-skill",
          purpose: "staging_source",
          windows_directory: ".\\attention-skill",
        },
        package_ref: null,
        source_kind: "public_url",
      },
    });
    expect(getAgentInstallationProfile("hermes")).toMatchObject({
      inbound: {
        docs_url:
          "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md",
      },
      mcp: {
        probe_evidence: "health_checked",
        probe_command_template: {
          args: ["mcp", "test", "attention"],
          executable: "hermes",
        },
      },
      skill: {
        delivery: "remote_url",
        install: "raw_url",
        install_command_template: {
          args: ["skills", "install", "{skill_url}"],
          executable: "hermes",
        },
      },
    });
    expect(getAgentInstallationProfile("codex").mcp.probe_evidence).toBe(
      "config_only",
    );
    expect(getAgentInstallationProfile("codex").compatibility).toMatchObject({
      command_checks: [
        { args: ["mcp", "add", "--help"], executable: "codex" },
        { args: ["mcp", "get", "--help"], executable: "codex" },
      ],
      minimum_version: null,
      policy: "verify_at_install",
    });
    expect(getAgentInstallationProfile("hermes").compatibility.command_checks)
      .toHaveLength(3);
  });

  it("keeps Runtime OAuth separate from MCP OAuth without claiming it shipped", () => {
    for (const id of [
      "openclaw",
      "hermes",
      "codex",
      "claude-code",
    ] as const) {
      const profile = getAgentInstallationProfile(id);
      expect(profile.mcp.oauth_client).toBe("dedicated_mcp_client");
      expect(profile.runtime_reporting).toEqual({
        availability: "contract_only",
        heartbeat: "runtime",
        mode: "attention_runtime_oauth",
        oauth_client_boundary: "separate_from_mcp",
        pairing_reports: true,
        resource_url_template: "{attention_origin}/api/runtime",
        scopes: CHANNEL_RUNTIME_SCOPES,
      });
      expect(profile.claims).toMatchObject({
        can_confirm_channel_pairing: false,
        can_confirm_runtime: false,
      });
      expect(profile.install_steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            availability: "contract_only",
            id: "authorize_runtime",
          }),
        ]),
      );
    }
  });

  it("publishes the WorkBuddy bundle without inventing Runtime or pairing events", () => {
    const profile = getAgentInstallationProfile("workbuddy");
    expect(profile).toMatchObject({
      compatibility: {
        minimum_version: "4.8.2",
        policy: "pinned",
      },
      channel: {
        availability: "host_managed_unverifiable",
        status_evidence: "host_ui_only",
      },
      runtime_reporting: {
        availability: "unsupported",
        heartbeat: "unavailable",
        mode: "none",
        oauth_client_boundary: "not_applicable",
        pairing_reports: false,
        resource_url_template: null,
        scopes: [],
      },
      skill: {
        availability: "available",
        bundle_path: ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
        bundle_sha256: ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
        bundle_skill_path: "SKILL.md",
        delivery: "host_upload_bundle",
        install: "upload_bundle",
        install_command_template: null,
        package_ref: ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
        source_kind: "upload_bundle",
      },
    });
    expect(profile.install_steps.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "authorize_runtime",
        "register_runtime",
        "verify_pairing",
      ]),
    );
  });

  it("separates Desktop interaction from inbound activation", () => {
    for (const id of ["codex", "claude-code"] as const) {
      const profile = getAgentInstallationProfile(id);
      expect(profile.restricted_profile).toMatchObject({
        allowed_mcp_servers: ["attention"],
        required: true,
        template_path: ATTENTION_RESTRICTED_PROFILE_PUBLIC_PATH,
      });
    }
    expect(getAgentInstallationProfile("codex").desktop).toEqual({
      inbound: "unsupported",
      interactive: "available",
      platforms: ["macos", "windows"],
      shared_skill_mcp: true,
      visible_session: "not_applicable",
    });
    expect(getAgentInstallationProfile("claude-code").desktop).toEqual({
      inbound: "unsupported",
      interactive: "available",
      platforms: ["macos", "linux", "windows"],
      shared_skill_mcp: true,
      visible_session: "not_applicable",
    });
    for (const id of ["codex", "claude-code"] as const) {
      expect(getAgentInstallationProfile(id).inbound).toMatchObject({
        availability: "available",
        engine: "attention_channel_bridge",
        requires_running_cli: true,
        stable_alternative: null,
      });
      expect(getAgentInstallationProfile(id).channel).toMatchObject({
        availability: "available",
        mode: "bridge",
        status_evidence: "running_cli_only",
      });
      expect(getAgentInstallationProfile(id).install_steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            availability: "available",
            executor: "attention_installer",
            id: "configure_restricted_profile",
          }),
          expect.objectContaining({
            availability: "available",
            credential_target: "local_channel",
            id: "start_inbound",
          }),
          expect.objectContaining({
            availability: "available",
            credential_target: "local_channel",
            executor: "user",
            id: "connect_channel",
          }),
        ]),
      );
      expect(
        getAgentInstallationProfile(id).channel.setup_command_templates,
      ).toEqual([
        {
          args: [
            "channel",
            "start",
            id,
            "--origin",
            "{attention_origin}",
            "--background",
          ],
          executable: "attention",
        },
      ]);
    }
    expect(getAgentInstallationProfile("claude-code").compatibility).toEqual({
      command_checks: [],
      minimum_version: "2.1.226",
      policy: "pinned",
    });
  });

  it("publishes actionable local Skill destinations instead of UI placeholders", () => {
    expect(getAgentInstallationProfile("codex").skill.local_path).toEqual({
      entrypoint: "SKILL.md",
      posix_directory: "~/.agents/skills/attention",
      purpose: "install_target",
      windows_directory: "%USERPROFILE%\\.agents\\skills\\attention",
    });
    expect(getAgentInstallationProfile("claude-code").skill.local_path).toEqual({
      entrypoint: "SKILL.md",
      posix_directory: "~/.claude/skills/attention",
      purpose: "install_target",
      windows_directory: "%USERPROFILE%\\.claude\\skills\\attention",
    });
    expect(getAgentInstallationProfile("openclaw").skill.local_path).toEqual({
      entrypoint: "SKILL.md",
      posix_directory: "./attention-skill",
      purpose: "staging_source",
      windows_directory: ".\\attention-skill",
    });
    expect(getAgentInstallationProfile("hermes").skill.local_path).toBeNull();
    expect(getAgentInstallationProfile("workbuddy").skill.local_path).toBeNull();
  });

  it("separates non-interactive MCP configuration from interactive host setup", () => {
    expect(getAgentInstallationProfile("hermes").mcp.setup_mode).toBe(
      "interactive_oauth",
    );
    expect(
      getAgentInstallationProfile("hermes").install_steps.find(
        ({ id }) => id === "configure_mcp",
      )?.executor,
    ).toBe("user");
    expect(getAgentInstallationProfile("workbuddy").mcp.setup_mode).toBe(
      "host_ui",
    );
    for (const id of ["openclaw", "codex", "claude-code"] as const) {
      expect(getAgentInstallationProfile(id).mcp.setup_mode).toBe(
        "noninteractive_then_login",
      );
      expect(
        getAgentInstallationProfile(id).install_steps.find(
          ({ id: stepId }) => stepId === "configure_mcp",
        )?.executor,
      ).toBe("attention_installer");
    }
  });

  it("never represents local channel credentials as hosted or identifiable", () => {
    for (const profile of agentInstallationProfiles) {
      expect(() =>
        AgentInstallationProfileSchema.parse(profile),
      ).not.toThrow();
      expect(profile.channel).toMatchObject({
        credentials: "local_device_only",
        hosted_by_attention: false,
      });
      expect(profile.claims.can_confirm_wechat_identity).toBe(false);
    }
    expect(getAgentInstallationProfile("codex").compatibility).toEqual({
      command_checks: [
        { args: ["mcp", "add", "--help"], executable: "codex" },
        { args: ["mcp", "get", "--help"], executable: "codex" },
      ],
      minimum_version: null,
      policy: "verify_at_install",
    });
    expect(getAgentInstallationProfile("hermes").compatibility).toEqual({
      command_checks: [
        { args: ["skills", "install", "--help"], executable: "hermes" },
        { args: ["mcp", "add", "--help"], executable: "hermes" },
        { args: ["mcp", "test", "--help"], executable: "hermes" },
      ],
      minimum_version: null,
      policy: "verify_at_install",
    });
  });

  it("ships a restrictive, host-neutral bridge profile template", () => {
    expect(() =>
      RestrictedAgentProfileTemplateSchema.parse(
        restrictedAgentProfileTemplate,
      ),
    ).not.toThrow();
    expect(restrictedAgentProfileTemplate).toMatchObject({
      capabilities: {
        allow_mcp_servers: ["attention"],
        allow_mcp_tool_prefixes: ["attention_"],
      },
      context: {
        inherit_session_history: false,
        inherit_working_directory: false,
      },
      logging: {
        include_channel_credentials: false,
        include_full_message_body: false,
      },
    });
  });
});
