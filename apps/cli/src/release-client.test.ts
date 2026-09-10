import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {ATTENTION_BRIDGE_PERMISSION_PROFILE as profile, ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256 as profileSha, type BridgeUpdateManifest} from "./bridge-update-contract";
import {
  fetchAttentionReleaseArtifact,
  fetchAttentionReleaseManifest,
  nodeRuntimeSatisfies,
  fetchAttentionPermissionProfile,
} from "./release-client";

const origin = "https://attention.example";
const manifestUrl = `${origin}/cli/manifest.json`;
const artifactUrl = `${origin}/cli/attention-0.3.13.mjs`;
const artifact = Buffer.from("#!/usr/bin/env node\nconsole.log('candidate');\n");
const manifest: BridgeUpdateManifest = {
  artifact_path: "/cli/attention-0.3.13.mjs",
  minimum_supported_version: "0.3.5",
  node: ">=22.16.0",
  permission_profile_sha256: "a".repeat(64),
  schema_version: 2,
  sha256: createHash("sha256").update(artifact).digest("hex"),
  version: "0.3.13",
};

function responseAt(
  url: string,
  body: BodyInit,
  init?: ResponseInit,
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("Attention release client", () => {
  it("loads the exact same-origin permission sidecar and checks its fingerprint",async()=>{
    const result=await fetchAttentionPermissionProfile({origin,sha256:profileSha,timeoutMs:1000,fetchImpl:async(input,init)=>{
      expect(String(input)).toBe(`${origin}/cli/permissions/${profileSha}.json`);
      expect(init?.redirect).toBe("error");return responseAt(String(input),JSON.stringify(profile),{headers:{"content-type":"application/json"}});
    }});
    expect(result).toEqual(profile);
  });
  it.each(["missing","redirect","tampered","oversized"])("rejects %s permission metadata without trusting remote prose",async(kind)=>{
    await expect(fetchAttentionPermissionProfile({origin,sha256:profileSha,timeoutMs:1000,fetchImpl:async(input)=>responseAt(kind==="redirect"?"https://other.example/profile.json":String(input),kind==="oversized"?" ".repeat(16385):JSON.stringify(kind==="tampered"?{...profile,schema_version:99}:profile),{status:kind==="missing"?404:200,headers:{"content-type":"application/json"}})})).rejects.toThrow();
  });
  it("cancels a chunked body as soon as it exceeds the manifest byte limit",async()=>{
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}});
    await expect(fetchAttentionReleaseManifest({origin,timeoutMs:1000,fetchImpl:async()=>responseAt(manifestUrl,stream,{headers:{"content-type":"application/json"}})})).rejects.toMatchObject({code:"manifest_too_large"});
    expect(cancelled).toBe(true);
  });
  it("loads a strict JSON manifest from the exact requested origin", async () => {
    const requested: string[] = [];

    const result = await fetchAttentionReleaseManifest({
      fetchImpl: async (input, init) => {
        requested.push(String(input));
        expect(init).toMatchObject({ redirect: "error" });
        return responseAt(manifestUrl, JSON.stringify(manifest), {
          headers: { "content-type": "application/json; charset=utf-8" },
          status: 200,
        });
      },
      origin,
      timeoutMs: 1_500,
    });

    expect(result).toEqual(manifest);
    expect(requested).toEqual([manifestUrl]);
  });

  it.each([
    {
      code: "manifest_redirected",
      response: responseAt(
        "https://redirect.example/cli/manifest.json",
        JSON.stringify(manifest),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    },
    {
      code: "manifest_content_type",
      response: responseAt(manifestUrl, JSON.stringify(manifest), {
        headers: { "content-type": "text/plain" },
        status: 200,
      }),
    },
    {
      code: "manifest_too_large",
      response: responseAt(manifestUrl, JSON.stringify(manifest), {
        headers: {
          "content-length": "16385",
          "content-type": "application/json",
        },
        status: 200,
      }),
    },
    {
      code: "manifest_invalid_json",
      response: responseAt(manifestUrl, "{", {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    },
    {
      code: "manifest_invalid",
      response: responseAt(
        manifestUrl,
        JSON.stringify({ ...manifest, unexpected: true }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    },
  ])("rejects an unsafe manifest as $code", async ({ code, response }) => {
    await expect(
      fetchAttentionReleaseManifest({
        fetchImpl: async () => response,
        origin,
        timeoutMs: 1_500,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("downloads an exact-origin artifact only when its SHA-256 matches", async () => {
    const result = await fetchAttentionReleaseArtifact({
      fetchImpl: async () =>
        responseAt(artifactUrl, artifact, {
          headers: { "content-length": String(artifact.byteLength) },
          status: 200,
        }),
      manifest,
      origin,
      timeoutMs: 15_000,
    });

    expect(result).toEqual(artifact);
  });

  it.each([
    {
      code: "artifact_redirected",
      response: responseAt("https://cdn.example/attention.mjs", artifact, {
        status: 200,
      }),
    },
    {
      code: "artifact_digest_mismatch",
      response: responseAt(artifactUrl, Buffer.from("tampered"), {
        status: 200,
      }),
    },
  ])("rejects an unsafe artifact as $code", async ({ code, response }) => {
    await expect(
      fetchAttentionReleaseArtifact({
        fetchImpl: async () => response,
        manifest,
        origin,
        timeoutMs: 15_000,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("compares the running Node version with the manifest minimum", () => {
    expect(nodeRuntimeSatisfies("22.16.0", ">=22.16.0")).toBe(true);
    expect(nodeRuntimeSatisfies("24.0.0", ">=22.16.0")).toBe(true);
    expect(nodeRuntimeSatisfies("22.15.9", ">=22.16.0")).toBe(false);
    expect(nodeRuntimeSatisfies("not-semver", ">=22.16.0")).toBe(false);
  });
});
