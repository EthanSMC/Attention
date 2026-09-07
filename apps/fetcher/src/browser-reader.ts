import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { FrameDecoder, WireBudget, encodeFrame, ProtocolError, type Frame } from "@attention/reader-browser/protocol";
import type { ReadRequest } from "@attention/content-reader-contracts";
import { BrowserUnavailableError, type BrowserReader } from "./read-document.js";
import { ResourceBroker } from "./renderer-resource.js";
import { safeFetchResource } from "./safe-fetch.js";
import { assertNoHttpsDowngrade, parseAndValidateUrl } from "./url-policy.js";

const configuration = z.object({
  runtimePath: z.enum(["/usr/bin/docker", "/usr/bin/podman"]),
  image: z.string().regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/u),
  seccompPath: z.string().regex(/^\/etc\/attention\/[a-zA-Z0-9._-]+\.json$/u),
  isolationVerified: z.literal(true),
}).strict();
type Configuration = z.infer<typeof configuration>;
const containerName = /^attention-reader-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export function buildLaunchArgs(config: unknown, name: string): string[] {
  const approved = configuration.parse(config);
  if (!containerName.test(name)) throw new ProtocolError();
  return ["run", "--interactive", "--pull=never", `--name=${name}`, "--network=none", "--ipc=private",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    `--security-opt=seccomp=${approved.seccompPath}`, "--user=10001:10001", "--pids-limit=128",
    "--memory=2g", "--memory-swap=2g", "--cpus=1", "--ulimit=nofile=1024:1024",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=192m,mode=1777", "--shm-size=64m", "--stop-timeout=1",
    "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=NODE_ENV=production", "--env=ATTENTION_ISOLATED_READER=1",
    "--entrypoint=node", approved.image, "/app/runner.js"];
}

/** A separate trusted coordinator must atomically consume the reference AND claim
 * a shared physical browser slot. Lease expiry never proves renderer termination. */
export interface BrowserAdmission {
  consume(input: {reference: string; request_ref: string; attempt_ref: string;
    source_fingerprint: string; renderer_ref: string; signal: AbortSignal}): Promise<{
      signal: AbortSignal;
      release(): Promise<void>;
    } | null>;
}
export class RendererCleanupError extends BrowserUnavailableError {
  constructor() { super(false); }
}

export function withBrowserAdmission(browser: BrowserReader, admission: BrowserAdmission | null,
  reference: string | undefined, request: ReadRequest): BrowserReader {
  return {async read(input) {
    if (!admission || !reference || !/^[A-Za-z0-9._:-]{1,128}$/u.test(reference)) throw new BrowserUnavailableError(false);
    const source = parseAndValidateUrl(request.url, request.sourceKind).toString();
    const renderer_ref = `attention-reader-${randomUUID()}`;
    const lease = await admission.consume({reference, request_ref: request.request_ref, attempt_ref: request.attempt_ref,
      source_fingerprint: createHash("sha256").update(source).digest("hex"), renderer_ref, signal: input.signal});
    if (!lease) throw new BrowserUnavailableError(false);
    let cleanupConfirmed = true;
    try {
      const signal = AbortSignal.any([input.signal, lease.signal]);
      signal.throwIfAborted();
      return await browser.read({...input, signal, renderer_ref});
    } catch (error) {
      if (error instanceof RendererCleanupError) cleanupConfirmed = false;
      throw error;
    } finally {
      // A failed/orphaned slot stays quarantined until trusted cleanup or fencing.
      if (cleanupConfirmed) await lease.release();
    }
  }};
}

interface RendererProcess {
  stdin: Writable;
  stdout: Readable;
  closed: Promise<void>;
  kill(): void;
}
const launchOptions = {env: {PATH: "/usr/bin:/bin"}, stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"], shell: false as const};
interface Launcher {
  launch(runtime: string, args: string[], options: typeof launchOptions): RendererProcess;
  remove(runtime: string, name: string): Promise<void>;
}
const defaultLauncher: Launcher = {
  launch(runtime, args, options) {
    const child = spawn(runtime, args, options);
    const closed = new Promise<void>((resolve, reject) => {child.once("close", () => resolve()); child.once("error", () => reject(new BrowserUnavailableError(true)));});
    void closed.catch(() => undefined);
    return {stdin: child.stdin, stdout: child.stdout, closed, kill: () => {child.kill("SIGKILL");}};
  },
  async remove(runtime, name) {
    await promisify(execFile)(runtime, ["rm", "--force", name], {env: launchOptions.env, timeout: 5_000, maxBuffer: 4_096});
  },
};

function validateHost(config: Configuration): void {
  try {
    accessSync(config.runtimePath, constants.X_OK);
    const profile = JSON.parse(readFileSync(config.seccompPath, "utf8")) as {defaultAction?: string};
    if (profile.defaultAction !== "SCMP_ACT_ERRNO") throw new Error();
  } catch { throw new BrowserUnavailableError(false); }
}

export function createIsolatedBrowserReader(config: unknown, launcher: Launcher = defaultLauncher,
  fetchResource: typeof safeFetchResource = safeFetchResource): BrowserReader {
  const approved = configuration.parse(config);
  if (launcher === defaultLauncher) validateHost(approved);
  return {async read(input) {
    input.signal.throwIfAborted();
    const initial = parseAndValidateUrl(input.url, input.sourceKind);
    const name = input.renderer_ref ?? `attention-reader-${randomUUID()}`;
    const child = launcher.launch(approved.runtimePath, buildLaunchArgs(approved, name), launchOptions);
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 60_000);
    const budget = new WireBudget();
    const decoder = new FrameDecoder(budget);
    const broker = new ResourceBroker(input.sourceKind, signal, fetchResource);
    const operations = new Set<Promise<void>>();
    let complete: Extract<Frame, {kind: "complete"}> | null = null;
    let failure: unknown;
    let failed = false;
    let cleanupFailed = false;
    let killed = false;
    const kill = (): void => { if (!killed) {killed = true; child.kill();} };
    const abort = (): void => { kill(); child.stdout.destroy(); };
    signal.addEventListener("abort", abort, {once: true});
    const write = async (frame: Frame): Promise<void> => {
      signal.throwIfAborted();
      const bytes = encodeFrame(frame, budget);
      await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
    };
    try {
      await write({kind: "start", url: initial.toString(), sourceKind: input.sourceKind});
      for await (const chunk of child.stdout) {
        for (const frame of decoder.push(chunk as Uint8Array)) {
          if (complete) throw new ProtocolError();
          if (frame.kind === "resource") {
            const operation = broker.read(frame).then(reply => write(reply)).catch(error => {
              failure = error; controller.abort();
            });
            operations.add(operation);
            void operation.finally(() => operations.delete(operation));
          } else if (frame.kind === "complete") {
            const final = parseAndValidateUrl(frame.finalUrl, input.sourceKind);
            assertNoHttpsDowngrade(initial, final);
            const trustedStatus = broker.documentStatus(final.toString());
            if (trustedStatus === undefined) throw new ProtocolError();
            complete = {...frame, status: trustedStatus};
          } else if (frame.kind === "failed") {
            throw new ProtocolError();
          } else throw new ProtocolError();
        }
      }
      decoder.finish();
      await Promise.allSettled(operations);
      signal.throwIfAborted();
      if (failure) throw failure;
      if (!complete) throw new BrowserUnavailableError(true);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
      kill();
      child.stdin.destroy();
      child.stdout.destroy();
      await broker.close();
      await Promise.allSettled(operations);
      try {
        await launcher.remove(approved.runtimePath, name);
        await child.closed;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new RendererCleanupError();
    if (failed) throw failure;
    if (!complete) throw new ProtocolError();
    return {html: complete.html, finalUrl: complete.finalUrl, status: complete.status};
  }};
}
