import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { Resolver } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { Agent, buildConnector, fetch } from "undici";

import { FetcherError } from "./errors.js";
import { isPublicAddress } from "./ip-policy.js";
import {
  assertNoHttpsDowngrade,
  parseAndValidateUrl,
  type SourceKind
} from "./url-policy.js";

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 8_000;
const DNS_ATTEMPT_TIMEOUT_MS = 2_000;

export type AddressResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<LookupAddress[]>;

export interface SafeFetchOptions {
  resolveAddresses?: AddressResolver;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RedirectHop {
  host: string;
  pathFingerprint: string;
  status: number;
}

export interface SafeFetchResult {
  retryAfter?: string;
  body?: string;
  contentType?: string;
  finalUrl: string;
  redirects: RedirectHop[];
  status: number;
}

function fingerprintPath(url: URL): string {
  return createHash("sha256").update(url.pathname).digest("hex").slice(0, 16);
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();

  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

const resolveAddresses: AddressResolver = async (hostname, signal) => {
  const normalizedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const literalFamily = isIP(normalizedHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: normalizedHostname, family: literalFamily }];
  }

  const resolver = new Resolver({ timeout: DNS_ATTEMPT_TIMEOUT_MS, tries: 2 });
  const cancel = (): void => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [ipv4, ipv6] = await Promise.allSettled([
      resolver.resolve4(normalizedHostname),
      resolver.resolve6(normalizedHostname),
    ]);
    const addresses: LookupAddress[] = [];
    if (ipv4.status === "fulfilled") {
      addresses.push(...ipv4.value.map((address) => ({ address, family: 4 as const })));
    }
    if (ipv6.status === "fulfilled") {
      addresses.push(...ipv6.value.map((address) => ({ address, family: 6 as const })));
    }
    if (addresses.length === 0) {
      throw ipv4.status === "rejected" ? ipv4.reason : ipv6.status === "rejected"
        ? ipv6.reason
        : new Error("Hostname did not resolve");
    }
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

async function resolvePinnedAddress(
  hostname: string,
  signal: AbortSignal,
  addressResolver: AddressResolver,
): Promise<{
  address: string;
  family: 4 | 6;
}> {
  let addresses: LookupAddress[];
  try {
    addresses = await raceWithAbort(addressResolver(hostname, signal), signal);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new FetcherError("timeout", "Request exceeded the time limit");
    }
    throw new FetcherError("dns_failure", "Hostname could not be resolved");
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new FetcherError("unsafe_address", "Hostname resolves to a non-public address");
  }

  const first = addresses[0];
  if (!first || (first.family !== 4 && first.family !== 6)) {
    throw new FetcherError("dns_failure", "Hostname did not resolve to IPv4 or IPv6");
  }

  return { address: first.address, family: first.family };
}

function createPinnedAgent(address: string, family: 4 | 6): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };

  const connector = buildConnector({
    timeout: 2_000,
    lookup
  });

  return new Agent({
    bodyTimeout: TOTAL_TIMEOUT_MS,
    connect(options, callback) {
      connector(options, (error, socket) => {
        if (error || !socket) {
          callback(error ?? new Error("Connection failed"), null);
          return;
        }

        const remoteAddress = socket.remoteAddress;
        if (!remoteAddress || remoteAddress !== address) {
          socket.destroy();
          callback(new Error("Connected peer did not match the pinned address"), null);
          return;
        }

        callback(null, socket);
      });
    },
    headersTimeout: TOTAL_TIMEOUT_MS,
    maxHeaderSize: 64 * 1024,
    pipelining: 0
  });
}

export async function readLimitedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        throw new FetcherError("response_too_large", "Response exceeded the HTML limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

async function fetchPinned(
  rawUrl: string,
  sourceKind: SourceKind,
  mode: "resolve" | "metadata" | "read" | "resource",
  options: SafeFetchOptions = {},
  byteLimit = MAX_HTML_BYTES,
): Promise<SafeFetchResult & {bytes?: Uint8Array}> {
  const timeoutMs = Math.min(options.timeoutMs ?? TOTAL_TIMEOUT_MS, TOTAL_TIMEOUT_MS);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const redirects: RedirectHop[] = [];
    let current = parseAndValidateUrl(rawUrl, sourceKind);

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const { address, family } = await resolvePinnedAddress(
        current.hostname,
        signal,
        options.resolveAddresses ?? resolveAddresses,
      );
      const dispatcher = createPinnedAgent(address, family);

      try {
        const response = await fetch(current, {
          dispatcher,
          headers: {
            accept: mode === "metadata" ? "text/html,application/xhtml+xml" : "*/*",
            "accept-encoding": "identity",
            "user-agent": "AttentionFetcher/0.1"
          },
          redirect: "manual",
          signal
        });

        redirects.push({
          host: current.hostname,
          pathFingerprint: fingerprintPath(current),
          status: response.status
        });

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location) {
            throw new FetcherError(
              "redirect_missing_location",
              "Redirect response did not include a location"
            );
          }
          if (redirectCount === MAX_REDIRECTS) {
            throw new FetcherError("redirect_limit", "Redirect limit exceeded");
          }

          const next = parseAndValidateUrl(new URL(location, current).toString(), sourceKind);
          assertNoHttpsDowngrade(current, next);
          current = next;
          continue;
        }

        const contentType = response.headers.get("content-type") ?? undefined;
        const retryAfter = response.headers.get("retry-after")?.slice(0, 128);
        if (mode === "resolve") {
          await response.body?.cancel();
          return {
            ...(contentType ? { contentType } : {}),
            finalUrl: current.toString(),
            redirects,
            status: response.status
          };
        }

        if (mode === "resource") {
          return {bytes: await readLimitedBytes(response as unknown as Response, byteLimit, signal),
            ...(contentType ? {contentType} : {}), finalUrl: current.toString(), redirects, status: response.status};
        }
        if (!contentType?.toLowerCase().includes("text/html") &&
          !(mode === "read" && contentType?.toLowerCase().includes("application/xhtml+xml"))) {
          await response.body?.cancel();
          if (mode === "read" && (response.status < 200 || response.status >= 300)) {
            return {body: "", ...(contentType ? {contentType} : {}), ...(retryAfter ? {retryAfter} : {}),
              finalUrl: current.toString(), redirects, status: response.status};
          }
          throw new FetcherError(
            "unsupported_content_type",
            "Metadata mode only accepts HTML"
          );
        }

        return {
          body: new TextDecoder().decode(await readLimitedBytes(response as unknown as Response, MAX_HTML_BYTES, signal)),
          contentType,
          ...(mode === "read" && retryAfter ? {retryAfter} : {}),
          finalUrl: current.toString(),
          redirects,
          status: response.status
        };
      } finally {
        await dispatcher.destroy().catch(() => undefined);
      }
    }

    throw new FetcherError("redirect_limit", "Redirect limit exceeded");
  } catch (error) {
    if (error instanceof FetcherError) throw error;
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new FetcherError("timeout", "Request exceeded the time limit");
    }
    throw new FetcherError("fetch_failed", "The remote request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export async function safeFetch(rawUrl: string, sourceKind: SourceKind,
  mode: "resolve" | "metadata" | "read", options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  return await fetchPinned(rawUrl, sourceKind, mode, options);
}

export async function safeFetchResource(rawUrl: string, sourceKind: SourceKind,
  options: SafeFetchOptions & {maxBytes?: number} = {}): Promise<SafeFetchResult & {bytes: Uint8Array}> {
  const result = await fetchPinned(rawUrl, sourceKind, "resource", options,
    Math.max(0, Math.min(options.maxBytes ?? 2 * 1024 * 1024, 20 * 1024 * 1024)));
  return {...result, bytes: result.bytes ?? new Uint8Array()};
}
