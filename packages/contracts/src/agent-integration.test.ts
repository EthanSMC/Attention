import { describe, expect, it } from "vitest";

import {
  AGENT_INTEGRATION_IDS,
  AgentIntegrationSchema,
  agentIntegrationManifest,
  getAgentIntegration,
} from "./agent-integration";

describe("agent integration capability manifest", () => {
  it("covers every first-release local agent exactly once", () => {
    expect(agentIntegrationManifest.map((item) => item.id)).toEqual([
      "openclaw",
      "hermes",
      "codex",
      "claude-code",
      "workbuddy",
    ]);
    expect(new Set(AGENT_INTEGRATION_IDS).size).toBe(
      AGENT_INTEGRATION_IDS.length,
    );
    for (const integration of agentIntegrationManifest) {
      expect(() => AgentIntegrationSchema.parse(integration)).not.toThrow();
    }
  });

  it("keeps interactive MCP separate from channel and inbound delivery", () => {
    for (const integration of agentIntegrationManifest) {
      expect(integration.interactive.mcp).toBe("available");
      expect(integration.claims.can_confirm_mcp).toBe(true);
      expect(integration.claims.can_confirm_channel_pairing).toBe(false);
      expect(integration.claims.can_confirm_runtime).toBe(false);
      expect(integration.claims.can_confirm_wechat_identity).toBe(false);
    }

    expect(getAgentIntegration("codex")).toMatchObject({
      channel: { availability: "contract_only" },
      inbound: {
        availability: "contract_only",
        engine: "codex_sdk_companion",
      },
      interactive: { availability: "available", mcp: "available" },
    });
  });

  it("models OpenClaw and Hermes channel support as external host capability", () => {
    expect(getAgentIntegration("openclaw")).toMatchObject({
      channel: {
        availability: "available_external",
        owner: "openclaw",
        status_evidence: "host_cli_probe",
      },
      desktop: {
        inbound: "unsupported",
        interactive: "available",
        platforms: ["macos", "windows"],
        shared_skill_mcp: true,
      },
      inbound: {
        availability: "available_external",
        engine: "host_native",
        minimum_version: "2026.5.12",
      },
      runtime_reporting: {
        availability: "contract_only",
        mode: "attention_runtime_oauth",
      },
    });
    expect(getAgentIntegration("hermes")).toMatchObject({
      channel: {
        availability: "available_external",
        owner: "hermes",
        status_evidence: "host_cli_probe",
      },
      desktop: {
        inbound: "unsupported",
        interactive: "available",
        platforms: ["macos", "linux", "windows"],
      },
    });
  });

  it("does not invent WorkBuddy lifecycle events or identity export", () => {
    expect(getAgentIntegration("workbuddy")).toMatchObject({
      channel: {
        availability: "host_managed_unverifiable",
        owner: "workbuddy",
        status_evidence: "host_ui_only",
      },
      claims: {
        can_confirm_channel_pairing: false,
        can_confirm_runtime: false,
        can_confirm_wechat_identity: false,
      },
      runtime_reporting: {
        availability: "unsupported",
        heartbeat: "unavailable",
        mode: "none",
        pairing_reports: false,
      },
      interactive: {
        availability: "available",
        mcp: "available",
        skill: "available",
      },
    });
  });

  it("keeps Codex Desktop interactive-only until a companion ships", () => {
    expect(getAgentIntegration("codex")).toMatchObject({
      desktop: {
        inbound: "unsupported",
        interactive: "available",
        platforms: ["macos", "windows"],
        shared_skill_mcp: true,
        visible_session: "not_applicable",
      },
      inbound: {
        availability: "contract_only",
        engine: "codex_sdk_companion",
      },
    });
  });

  it("marks Claude Channels experimental and Desktop inbound unsupported", () => {
    expect(getAgentIntegration("claude-code")).toMatchObject({
      desktop: {
        inbound: "unsupported",
        interactive: "available",
        platforms: ["macos", "linux", "windows"],
        visible_session: "not_applicable",
      },
      inbound: {
        availability: "experimental",
        engine: "claude_channel_preview",
        minimum_version: "2.1.80",
        requires_running_cli: true,
        stable_alternative: {
          availability: "contract_only",
          engine: "claude_agent_sdk_byo_key",
          requires_byo_api_key: true,
        },
      },
    });
  });
});
