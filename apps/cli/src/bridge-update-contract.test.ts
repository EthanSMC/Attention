import { describe, expect, it } from "vitest";

import {
  ATTENTION_BRIDGE_PERMISSION_PROFILE,
  ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
  bridgeUpdateDecision,
  parseBridgeUpdateManifest,
  resolveBridgeUpdateArtifactUrl,
} from "./bridge-update-contract";

const manifest = {
  artifact_path: "/cli/attention-0.3.5.mjs",
  minimum_supported_version: "0.3.5",
  node: ">=22.16.0",
  permission_profile_sha256:
    "2b2bca585577cd6f0d2adc310f798a8e200ac6a274862b3564c9b36408c1606d",
  schema_version: 2,
  sha256: "a".repeat(64),
  version: "0.3.5",
} as const;

describe("Bridge update contract", () => {
  it("publishes one canonical permission boundary with a reviewed digest", () => {
    expect(JSON.stringify(ATTENTION_BRIDGE_PERMISSION_PROFILE)).toBe(
      '{"cloud":{"mcp_server":"attention_only","tools":["attention_get_my_account","attention_list_collections","attention_collect_content","attention_submit_content_enrichment","attention_select_collection_candidate","attention_get_collection_status","attention_update_collection"]},"local":{"deny":["browser_automation","code_execution","filesystem_outside_attention","other_mcp","shell"],"write":["attention_state","managed_bridge_artifacts","user_service_config"]},"native_network":["public_web_reader"],"schema_version":1}',
    );
    expect(ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256).toBe(
      "2b2bca585577cd6f0d2adc310f798a8e200ac6a274862b3564c9b36408c1606d",
    );
  });

  it("accepts only the strict versioned manifest", () => {
    expect(parseBridgeUpdateManifest(manifest)).toEqual(manifest);
    expect(
      parseBridgeUpdateManifest({ ...manifest, unexpected: true }),
    ).toBeNull();
    expect(
      parseBridgeUpdateManifest({ ...manifest, artifact_path: "https://evil.example/cli.mjs" }),
    ).toBeNull();
    expect(
      parseBridgeUpdateManifest({ ...manifest, version: "0.3" }),
    ).toBeNull();
  });

  it("resolves only an exact same-origin artifact without URL credentials or metadata", () => {
    expect(
      resolveBridgeUpdateArtifactUrl(
        "https://attention.example",
        manifest.artifact_path,
      ),
    ).toBe("https://attention.example/cli/attention-0.3.5.mjs");
    expect(() =>
      resolveBridgeUpdateArtifactUrl(
        "https://attention.example",
        "//cdn.example/attention.mjs",
      ),
    ).toThrow(/same origin/iu);
    expect(() =>
      resolveBridgeUpdateArtifactUrl(
        "https://attention.example",
        "/cli/attention.mjs?token=secret",
      ),
    ).toThrow(/metadata/iu);
  });

  it("requires unsupported releases and otherwise updates only newer same-major releases", () => {
    expect(
      bridgeUpdateDecision({
        currentPermissionProfileSha256:
          manifest.permission_profile_sha256,
        currentVersion: "0.3.4",
        manifest,
      }),
    ).toBe("update_required");
    expect(
      bridgeUpdateDecision({
        currentPermissionProfileSha256:
          manifest.permission_profile_sha256,
        currentVersion: "0.3.5",
        manifest,
      }),
    ).toBe("current");
    expect(
      bridgeUpdateDecision({
        currentPermissionProfileSha256: "b".repeat(64),
        currentVersion: "0.3.4",
        manifest,
      }),
    ).toBe("consent_required");
    expect(
      bridgeUpdateDecision({
        currentPermissionProfileSha256:
          manifest.permission_profile_sha256,
        currentVersion: "0.3.4",
        manifest: { ...manifest, version: "1.0.0" },
      }),
    ).toBe("consent_required");
  });

  it("marks an unsupported installed release as required even when no newer version exists", () => {
    expect(
      bridgeUpdateDecision({
        currentPermissionProfileSha256:
          manifest.permission_profile_sha256,
        currentVersion: "0.3.3",
        manifest: {
          ...manifest,
          minimum_supported_version: "0.3.4",
          version: "0.3.3",
        },
      }),
    ).toBe("update_required");

    expect(
      bridgeUpdateDecision({
        currentPermissionProfileSha256:
          manifest.permission_profile_sha256,
        currentVersion: "0.3.3",
        manifest: {
          ...manifest,
          minimum_supported_version: "0.3.5",
          version: "0.3.6",
        },
      }),
    ).toBe("update_required");
  });
});
