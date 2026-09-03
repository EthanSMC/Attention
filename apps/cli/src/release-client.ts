import { createHash } from "node:crypto";

import {
  type BridgeUpdateManifest,
  parseBridgeUpdateManifest,
  resolveBridgeUpdateArtifactUrl,
} from "./bridge-update-contract";
import { normalizeAttentionOrigin } from "./origin";

const MANIFEST_MAXIMUM_BYTES = 16_384;
const ARTIFACT_MAXIMUM_BYTES = 16 * 1024 * 1024;

export class AttentionReleaseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function nodeRuntimeSatisfies(version: string, range: string): boolean {
  const current = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(range);
  if (!current || !minimum) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(current[index]) - Number(minimum[index]);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function responseMatches(response: Response, expectedUrl: string): boolean {
  if (!response.url) return true;
  try {
    const actual = new URL(response.url);
    const expected = new URL(expectedUrl);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      !actual.search &&
      !actual.hash &&
      !actual.username &&
      !actual.password
    );
  } catch {
    return false;
  }
}

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
  errorCode: string,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new AttentionReleaseError(errorCode);
    }
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new AttentionReleaseError(errorCode);
  }
  return bytes;
}

async function fetchExact(
  fetchImpl: typeof fetch,
  url: string,
  maximumBytes: number,
  errorCode: string,
  timeoutMs: number,
): Promise<{ readonly bytes: Buffer; readonly response: Response }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json, text/javascript;q=0.9" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AttentionReleaseError(`${errorCode}_fetch_failed`);
  }
  if (response.status !== 200) {
    throw new AttentionReleaseError(`${errorCode}_http_status`);
  }
  if (!responseMatches(response, url)) {
    throw new AttentionReleaseError(`${errorCode}_redirected`);
  }
  return {
    bytes: await boundedResponseBytes(
      response,
      maximumBytes,
      `${errorCode}_too_large`,
    ),
    response,
  };
}

export async function fetchAttentionReleaseManifest(options: {
  readonly fetchImpl?: typeof fetch;
  readonly origin: string;
  readonly timeoutMs: number;
}): Promise<BridgeUpdateManifest> {
  const origin = normalizeAttentionOrigin(options.origin);
  const manifestUrl = new URL("/cli/manifest.json", `${origin}/`).toString();
  const result = await fetchExact(
    options.fetchImpl ?? fetch,
    manifestUrl,
    MANIFEST_MAXIMUM_BYTES,
    "manifest",
    options.timeoutMs,
  );
  const contentType = result.response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(contentType)) {
    throw new AttentionReleaseError("manifest_content_type");
  }
  let value: unknown;
  try {
    value = JSON.parse(result.bytes.toString("utf8"));
  } catch {
    throw new AttentionReleaseError("manifest_invalid_json");
  }
  const manifest = parseBridgeUpdateManifest(value);
  if (!manifest) throw new AttentionReleaseError("manifest_invalid");
  return manifest;
}

export async function fetchAttentionReleaseArtifact(options: {
  readonly fetchImpl?: typeof fetch;
  readonly manifest: BridgeUpdateManifest;
  readonly origin: string;
  readonly timeoutMs: number;
}): Promise<Buffer> {
  const origin = normalizeAttentionOrigin(options.origin);
  const artifactUrl = resolveBridgeUpdateArtifactUrl(
    origin,
    options.manifest.artifact_path,
  );
  const result = await fetchExact(
    options.fetchImpl ?? fetch,
    artifactUrl,
    ARTIFACT_MAXIMUM_BYTES,
    "artifact",
    options.timeoutMs,
  );
  const digest = createHash("sha256").update(result.bytes).digest("hex");
  if (digest !== options.manifest.sha256) {
    throw new AttentionReleaseError("artifact_digest_mismatch");
  }
  return result.bytes;
}
