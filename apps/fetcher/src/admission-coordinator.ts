import {setTimeout as delay} from "node:timers/promises";
import {z} from "zod";
import {createIsolatedBrowserReader, type BrowserAdmission} from "./browser-reader.js";
import {BrowserCapacityError, type BrowserReader} from "./read-document.js";

const configuration = z.object({origin: z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
}), secret: z.string().min(32).max(256)}).strict();
const claimSchema = z.object({claim: z.string().uuid()}).strict();

export function createAdmissionCoordinator(config: unknown, fetcher: typeof fetch = fetch): BrowserAdmission {
  const approved = configuration.parse(config);
  const origin = new URL(approved.origin).origin;
  async function call(action: "consume" | "release" | "status", body: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(1000);
    const response = await fetcher(`${origin}/api/internal/source-reader/${action}`, {method: "POST", redirect: "error", cache: "no-store",
      headers: {authorization: `Bearer ${approved.secret}`, "content-type": "application/json"}, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    if (!response.ok && response.status !== 429) {await response.body?.cancel(); throw new Error("reader_admission_unavailable");}
    const reader = response.body?.getReader(); if (!reader) throw new Error("reader_admission_unavailable");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {const item = await reader.read(); if (item.done) break;
        length += item.value.byteLength; if (length > 4096) {await reader.cancel(); throw new Error("reader_admission_unavailable");} chunks.push(item.value);}
    } finally {reader.releaseLock();}
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (response.status === 429 && action === "consume") {
      const denial = z.object({code: z.literal("rate_limited"), retry_after_ms: z.number().int().min(1).max(5000)}).strict().parse(payload);
      throw new BrowserCapacityError(denial.retry_after_ms);
    }
    return payload;
  }
  return {async consume(input) {
    const {signal: ownerSignal, ...body} = input;
    let claim: string;
    try {claim = claimSchema.parse(await call("consume", body, ownerSignal)).claim;}
    catch (error) {if (error instanceof BrowserCapacityError) throw error; return null;}
    const stop = new AbortController(), controller = new AbortController();
    const signal = AbortSignal.any([ownerSignal, controller.signal, AbortSignal.timeout(90_000)]);
    const proof = {...body, claim};
    const monitor = (async () => {
      try {while (!signal.aborted && !stop.signal.aborted) {
        await delay(500, undefined, {signal: AbortSignal.any([stop.signal, signal])});
        const status = z.object({active: z.literal(true)}).strict().safeParse(await call("status", proof, signal));
        if (!status.success) {controller.abort(); break;}
      }} catch {if (!stop.signal.aborted) controller.abort();}
    })();
    return {signal, async release() {
      // Caller invokes only after confirmed exact-container cleanup, even if the owner signal is aborted.
      stop.abort(); await monitor;
      const result = z.object({released: z.literal(true)}).strict().safeParse(await call("release", proof));
      if (!result.success) throw new Error("reader_cleanup_release_unconfirmed");
    }};
  }};
}

/** Fixed operator configuration only; absent/unattested OCI remains disabled. */
export function readerStartupOptions(env: NodeJS.ProcessEnv): {browser?: BrowserReader; browserAdmission?: BrowserAdmission} {
  if (!env.ATTENTION_READER_BACKEND || env.ATTENTION_READER_BACKEND === "disabled") return {};
  if (env.ATTENTION_READER_BACKEND !== "isolated_oci" || env.ATTENTION_READER_ISOLATION_VERIFIED !== "true")
    throw new Error("reader_isolation_acceptance_required");
  const browserAdmission = createAdmissionCoordinator({origin: env.ATTENTION_READER_COORDINATOR_ORIGIN, secret: env.ATTENTION_READER_COORDINATOR_SECRET});
  const browser = createIsolatedBrowserReader({runtimePath: env.ATTENTION_READER_OCI_RUNTIME, image: env.ATTENTION_READER_OCI_IMAGE,
    seccompPath: env.ATTENTION_READER_SECCOMP_PATH, isolationVerified: true});
  return {browser, browserAdmission};
}
