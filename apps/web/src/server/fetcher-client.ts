import { z } from "zod";
import {ReadResultSchema, readFailurePolicy, type ReadRequest, type ReadResult} from "@attention/content-reader-contracts";
import {classifyDocument, evidenceToReadResult} from "@attention/content-reader";
import {parseAndValidateUrl, assertNoHttpsDowngrade} from "@attention/fetcher/url-policy";

import {
  normalizeCredentialEndpoint,
  type SourceAdapterId,
} from "@attention/contracts";

const redirectHopSchema = z.object({
  host: z.string().min(1).max(255),
  pathFingerprint: z.string().min(1).max(128),
  status: z.number().int().min(100).max(599),
});

const fetcherSuccessSchema = z.object({
  finalUrl: z.string().url().max(4_096),
  redirects: z.array(redirectHopSchema).max(6),
  status: z.number().int().min(100).max(599),
});

const fetcherErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(100),
    request_id: z.string().uuid().optional(),
  }),
});

const unsafeFetcherCodes = new Set([
  "https_downgrade",
  "invalid_url",
  "unsafe_address",
  "unsafe_credentials",
  "unsafe_hostname",
  "unsupported_port",
  "unsupported_protocol",
]);

export class FetcherClientError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  readonly unsafe: boolean;

  constructor(code: string, unsafe = false, requestId: string | null = null) {
    super(code);
    this.name = "FetcherClientError";
    this.code = code;
    this.requestId = requestId;
    this.unsafe = unsafe;
  }
}

function fetcherConfiguration(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.FETCHER_BASE_URL?.trim();
  const secret = process.env.FETCHER_SHARED_SECRET?.trim();
  if (!baseUrl || !secret || secret.length < 32) {
    throw new FetcherClientError("fetcher_not_configured");
  }
  try {
    return {
      baseUrl: normalizeCredentialEndpoint(baseUrl, "FETCHER_BASE_URL", {
        allowedInsecureHosts: ["fetcher"],
      }),
      secret,
    };
  } catch {
    throw new FetcherClientError("fetcher_not_configured");
  }
}

export interface ResolvedExternalUrl {
  finalUrl: string;
  redirectChain: string[];
}

export async function readExternalSource(request: ReadRequest,
  options: {signal: AbortSignal; admissionReference: string}): Promise<ReadResult> {
  const base = {schema_version: 1, request_ref: request.request_ref, attempt_ref: request.attempt_ref};
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
  const failure = (code: "reader_not_configured" | "unsafe_source") => {const policy = readFailurePolicy(code);
    return ReadResultSchema.parse({...base, attempts: [], outcome: "failed", code, scope: policy.scope, recovery: policy.recovery,
      retry_after_ms: null, evidence_kind: "none", metadata: {author: null, title: null, description: null, published_at: null}});};
  let config: ReturnType<typeof fetcherConfiguration>;
  try {config = fetcherConfiguration();}
  catch {return failure("reader_not_configured");}
  try {parseAndValidateUrl(request.url, request.sourceKind);} catch {return failure("unsafe_source");}
  try {
  const response = await readerFetch(`${config.baseUrl}/v1/read`, {method: "POST", redirect: "error", cache: "no-store",
    body: JSON.stringify(request), signal,
    headers: {authorization: `Bearer ${config.secret}`, "content-type": "application/json", "x-reader-admission": options.admissionReference}});
  if (response.status === 404) {
    await response.body?.cancel();
    const started = performance.now();
    const initial = parseAndValidateUrl(request.url, request.sourceKind);
    const legacy = await readerFetch(`${config.baseUrl}/v1/fetch`, {method: "POST", redirect: "error", cache: "no-store", signal,
      body: JSON.stringify({mode: "metadata", sourceKind: request.sourceKind, url: request.url}),
      headers: {authorization: `Bearer ${config.secret}`, "content-type": "application/json"}});
    if (!legacy.ok) {await legacy.body?.cancel(); throw new FetcherClientError("fetcher_unavailable");}
    const payload = z.object({body: z.string().optional(), finalUrl: z.string().url(), status: z.number().int().min(100).max(599)})
      .parse(await boundedReaderJson(legacy, 3 * 1024 * 1024));
    const html = payload.body ?? "";
    if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new FetcherClientError("invalid_fetcher_response");
    const target = parseAndValidateUrl(payload.finalUrl, request.sourceKind);
    assertNoHttpsDowngrade(initial, target);
    signal.throwIfAborted();
    // Public DNS and connected-peer enforcement is attested by the authenticated legacy safeFetch response.
    const evidence = classifyDocument({html, finalUrl: target.toString(), sourceKind: request.sourceKind, status: payload.status});
    return evidenceToReadResult(evidence, {...base, schema_version: 1, attempts: [{method: "static", duration_ms: Math.min(90_000, Math.round(performance.now() - started))}],
      sourceKind: request.sourceKind, finalUrl: target.toString(), readAt: new Date().toISOString(), exhausted: true});
  }
  if (!response.ok) {await response.body?.cancel(); throw new FetcherClientError("fetcher_unavailable");}
  const result = ReadResultSchema.parse(await boundedReaderJson(response, 256 * 1024));
  if (result.request_ref !== request.request_ref || result.attempt_ref !== request.attempt_ref) throw new FetcherClientError("invalid_fetcher_response");
  if (result.outcome === "ready") {
    assertNoHttpsDowngrade(parseAndValidateUrl(request.url, request.sourceKind), parseAndValidateUrl(result.final_public_url, request.sourceKind));
  }
  return result;
  } catch (error) {
    if (error instanceof FetcherClientError) throw error;
    throw new FetcherClientError(signal.aborted ? "fetcher_timeout" : "invalid_fetcher_response");
  }
}

async function readerFetch(url: string, init: RequestInit): Promise<Response> {
  try {return await fetch(url, init);}
  catch {throw new FetcherClientError(init.signal?.aborted ? "fetcher_timeout" : "fetcher_unavailable");}
}

async function boundedReaderJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new FetcherClientError("invalid_fetcher_response");
  let length = 0; const chunks: Uint8Array[] = [];
  try {while (true) {
    const item = await reader.read(); if (item.done) break;
    length += item.value.byteLength;
    if (length > limit) {await reader.cancel(); throw new FetcherClientError("invalid_fetcher_response");} chunks.push(item.value);
  }} finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function resolveExternalUrl(
  url: string,
  sourceKind: SourceAdapterId,
): Promise<ResolvedExternalUrl> {
  const configuration = fetcherConfiguration();
  let response: Response;
  try {
    response = await fetch(`${configuration.baseUrl}/v1/fetch`, {
      body: JSON.stringify({ mode: "resolve", sourceKind, url }),
      cache: "no-store",
      headers: {
        authorization: `Bearer ${configuration.secret}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new FetcherClientError("fetcher_unavailable");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = fetcherErrorSchema.safeParse(payload);
    const code = parsed.success ? parsed.data.error.code : "fetcher_failed";
    throw new FetcherClientError(
      code,
      unsafeFetcherCodes.has(code),
      parsed.success ? (parsed.data.error.request_id ?? null) : null,
    );
  }

  const parsed = fetcherSuccessSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FetcherClientError("invalid_fetcher_response");
  }

  return {
    finalUrl: parsed.data.finalUrl,
    redirectChain: parsed.data.redirects.map(
      (hop) => `${hop.status}:${hop.host}:${hop.pathFingerprint}`,
    ),
  };
}
