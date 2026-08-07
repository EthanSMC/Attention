import {
  ATTENTION_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  ATTENTION_MCP_OAUTH_AUDIENCE,
  ATTENTION_MCP_OAUTH_SCOPES,
  ATTENTION_MCP_TOOL_CONTRACT_VERSION,
  AttentionCapabilityManifestSchema,
  attentionCapabilityManifest,
} from "@attention/contracts";
import { oauthScopesByAudience } from "@attention/auth";
import { describe, expect, it } from "vitest";

import {
  ATTENTION_TOOL_CONTRACT_VERSION,
  ATTENTION_TOOL_NAMES,
} from "./attention-tool-registry";

describe("Attention Web and MCP capability manifest", () => {
  it("is schema-valid and maps every public MCP tool exactly once", () => {
    expect(() =>
      AttentionCapabilityManifestSchema.parse(attentionCapabilityManifest),
    ).not.toThrow();

    const manifestNames = attentionCapabilityManifest.mcp.tools.map(
      ({ tool_name }) => tool_name,
    );
    expect(manifestNames).toEqual(ATTENTION_TOOL_NAMES);
    expect(manifestNames).toHaveLength(14);
    expect(new Set(manifestNames).size).toBe(14);
  });

  it("uses only scopes authorized for the attention-mcp audience", () => {
    const allowedScopes = new Set(
      oauthScopesByAudience[ATTENTION_MCP_OAUTH_AUDIENCE],
    );

    expect(attentionCapabilityManifest.mcp.scopes).toEqual(
      ATTENTION_MCP_OAUTH_SCOPES,
    );
    expect(new Set(attentionCapabilityManifest.mcp.scopes)).toEqual(
      allowedScopes,
    );
    for (const capability of attentionCapabilityManifest.mcp.tools) {
      expect(capability.oauth.audience).toBe(ATTENTION_MCP_OAUTH_AUDIENCE);
      expect(capability.oauth.any_of_scopes.length).toBeGreaterThan(0);
      for (const scope of capability.oauth.any_of_scopes) {
        expect(allowedScopes.has(scope)).toBe(true);
      }
    }
  });

  it("keeps schema, manifest, and live tool contract versions aligned", () => {
    expect(attentionCapabilityManifest.schema_version).toBe(
      ATTENTION_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    );
    expect(attentionCapabilityManifest.mcp.contract_version).toBe(
      ATTENTION_MCP_TOOL_CONTRACT_VERSION,
    );
    expect(ATTENTION_MCP_TOOL_CONTRACT_VERSION).toBe(
      ATTENTION_TOOL_CONTRACT_VERSION,
    );
    for (const capability of attentionCapabilityManifest.mcp.tools) {
      expect(capability.contract_version).toBe(
        attentionCapabilityManifest.mcp.contract_version,
      );
    }
  });

  it("documents concrete security or product reasons for every Web-only boundary", () => {
    expect(attentionCapabilityManifest.web_only.map(({ id }) => id)).toEqual([
      "account.authentication",
      "account.security",
      "account.public-identity",
      "agent.credential-management",
      "membership.checkout",
      "growth.rewards",
    ]);

    for (const capability of attentionCapabilityManifest.web_only) {
      expect(capability.reason.length).toBeGreaterThanOrEqual(80);
      expect(capability.reason_code).toMatch(/_boundary$/u);
      expect(capability.web_surface.path).toMatch(/^\//u);
      expect(capability.reason.toLocaleLowerCase("en")).not.toContain(
        "not supported",
      );
    }
  });

  it("separates OAuth, transport, sync, and local runtime reporting from business tools", () => {
    expect(
      attentionCapabilityManifest.independent_protocols.map(({ id }) => id),
    ).toEqual([
      "oauth.authorization",
      "mcp.transport",
      "collection.sync",
      "local-agent.runtime-reporting",
    ]);
    expect(
      attentionCapabilityManifest.independent_protocols.find(
        ({ id }) => id === "mcp.transport",
      ),
    ).toMatchObject({
      audience: ATTENTION_MCP_OAUTH_AUDIENCE,
      path: "/mcp",
      scopes: ATTENTION_MCP_OAUTH_SCOPES,
    });
  });
});
