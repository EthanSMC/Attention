import { z } from "zod";

import type { SourceAdapterId } from "@attention/contracts";

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
  error: z.object({ code: z.string().min(1).max(100) }),
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
  readonly unsafe: boolean;

  constructor(code: string, unsafe = false) {
    super(code);
    this.name = "FetcherClientError";
    this.code = code;
    this.unsafe = unsafe;
  }
}

function fetcherConfiguration(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.FETCHER_BASE_URL?.trim();
  const secret = process.env.FETCHER_SHARED_SECRET?.trim();
  if (!baseUrl || !secret || secret.length < 32) {
    throw new FetcherClientError("fetcher_not_configured");
  }
  return { baseUrl: baseUrl.replace(/\/+$/u, ""), secret };
}

export interface ResolvedExternalUrl {
  finalUrl: string;
  redirectChain: string[];
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
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new FetcherClientError("fetcher_unavailable");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = fetcherErrorSchema.safeParse(payload);
    const code = parsed.success ? parsed.data.error.code : "fetcher_failed";
    throw new FetcherClientError(code, unsafeFetcherCodes.has(code));
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
