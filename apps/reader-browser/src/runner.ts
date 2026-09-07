import { chromium, type BrowserType, type Page, type CDPSession } from "playwright";
import { pathToFileURL } from "node:url";
import { FrameSchema, FrameDecoder, WireBudget, encodeFrame, ProtocolError,
  type Frame, type ResourceFrame, type ResourceReply } from "./protocol.js";

type RequestResource = (url: string, resourceType: ResourceFrame["resourceType"]) => Promise<ResourceReply>;
const CDP_RESOURCE_TYPES = new Map<string, ResourceFrame["resourceType"]>([
  ["Document", "document"], ["Script", "script"], ["Stylesheet", "stylesheet"], ["Fetch", "fetch"], ["XHR", "xhr"],
]);
interface PausedResource {
  requestId: string;
  frameId: string;
  resourceType: string;
  request: {url: string; method: string};
}

/** Container-internal CDP only. Unlike Playwright's HTTP route wrapper, Fetch
 * request-stage events include every redirect hop. Never continue a request. */
export async function installResourceInterception(session: CDPSession, request: RequestResource): Promise<{close(): Promise<void>}> {
  const {frameTree} = await session.send("Page.getFrameTree");
  const pending = new Set<Promise<void>>();
  const fail = async (requestId: string): Promise<void> => {
    await session.send("Fetch.failRequest", {requestId, errorReason: "BlockedByClient"});
  };
  const relay = async (event: PausedResource): Promise<void> => {
    const type = CDP_RESOURCE_TYPES.get(event.resourceType);
    try {
      if (event.frameId !== frameTree.frame.id || event.request.method !== "GET" || !type) {
        await fail(event.requestId); return;
      }
      const result = await request(event.request.url, type);
      if (result.kind === "resource_error") {await fail(event.requestId); return;}
      if (result.finalUrl !== event.request.url) {
        await session.send("Fetch.fulfillRequest", {requestId: event.requestId, responseCode: 302,
          responseHeaders: [{name: "Location", value: result.finalUrl}], body: ""});
      } else {
        await session.send("Fetch.fulfillRequest", {requestId: event.requestId, responseCode: result.status,
          responseHeaders: [{name: "Content-Type", value: result.contentType}], body: result.bodyBase64});
      }
    } catch { await fail(event.requestId).catch(() => undefined); }
  };
  const track = (operation: Promise<void>): void => {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  const paused = (event: PausedResource): void => {track(relay(event));};
  const authenticate = (event: {requestId: string}): void => {
    track(session.send("Fetch.continueWithAuth", {requestId: event.requestId,
      authChallengeResponse: {response: "CancelAuth"}}).then(() => undefined).catch(() => undefined));
  };
  session.on("Fetch.requestPaused", paused);
  session.on("Fetch.authRequired", authenticate);
  const close = async (): Promise<void> => {
    session.off("Fetch.requestPaused", paused);
    session.off("Fetch.authRequired", authenticate);
    await Promise.allSettled(pending);
  };
  try {
    await session.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Request"}], handleAuthRequests: true});
  } catch (error) {await close(); throw error;}
  // Caller closes the context before draining/removing interception. Disabling
  // Fetch on a live page would release paused requests to the network stack.
  return {close};
}

export class ResourceClient {
  private nextId = 1;
  private closed = false;
  private active = 0;
  private readonly pending = new Map<string, {resolve: (reply: ResourceReply) => void; reject: (error: unknown) => void}>();
  private readonly waiters: Array<{resolve: () => void; reject: (error: unknown) => void}> = [];
  constructor(private readonly send: (frame: Frame) => Promise<void>) {}
  async request(url: string, resourceType: ResourceFrame["resourceType"]): Promise<ResourceReply> {
    if (this.closed || this.nextId > 100) throw new ProtocolError();
    const id = String(this.nextId++);
    if (this.active >= 4) await new Promise<void>((resolve, reject) => this.waiters.push({resolve, reject}));
    else this.active++;
    if (this.closed) throw new ProtocolError();
    const response = new Promise<ResourceReply>((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
    });
    // Attach rejection handling before awaiting a potentially failing write.
    void response.catch(() => undefined);
    try { await this.send(FrameSchema.parse({kind: "resource", id, url, resourceType})); }
    catch (error) { this.close(); throw error; }
    return await response;
  }
  receive(frame: ResourceReply): void {
    const parsed = FrameSchema.parse(frame);
    if (parsed.kind !== "resource_result" && parsed.kind !== "resource_error") throw new ProtocolError();
    const waiter = this.pending.get(parsed.id);
    if (!waiter) throw new ProtocolError();
    this.pending.delete(parsed.id);
    waiter.resolve(parsed);
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
  }
  close(): void {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new ProtocolError());
    for (const waiter of this.waiters) waiter.reject(new ProtocolError());
    this.pending.clear(); this.waiters.length = 0;
  }
}

export async function runRenderer(start: Extract<Frame, {kind: "start"}>, request: RequestResource,
  signal: AbortSignal, browserType: Pick<BrowserType, "launch"> = chromium): Promise<Extract<Frame, {kind: "complete"}>> {
  signal.throwIfAborted();
  const browser = await browserType.launch({headless: true, chromiumSandbox: true,
    args: ["--disable-dev-shm-usage", "--disable-background-networking", "--disable-extensions"]});
  const abort = (): void => {void browser.close().catch(() => undefined);};
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({acceptDownloads: false, serviceWorkers: "block",
      javaScriptEnabled: true, permissions: [], storageState: {cookies: [], origins: []}});
    let interception: Awaited<ReturnType<typeof installResourceInterception>> | null = null;
    try {
      let mainPage: Page | null = null;
      context.on("page", page => {if (mainPage && page !== mainPage) void page.close().catch(() => undefined);});
      await context.routeWebSocket("**/*", socket => socket.close());
      mainPage = await context.newPage();
      interception = await installResourceInterception(await context.newCDPSession(mainPage), request);
      mainPage.on("download", download => {void download.cancel();});
      mainPage.on("dialog", dialog => {void dialog.dismiss();});
      const response = await mainPage.goto(start.url, {waitUntil: "domcontentloaded", timeout: 50_000});
      // Stop waiting when semantic content exists; short bounded settle for empty apps.
      await mainPage.waitForFunction(() => Boolean(document.querySelector("article, main, [itemprop='articleBody']")?.textContent?.trim()), undefined, {timeout: 5_000})
        .catch(() => undefined);
      signal.throwIfAborted();
      return FrameSchema.parse({kind: "complete", html: await mainPage.content(), finalUrl: mainPage.url(), status: response?.status() ?? 200}) as Extract<Frame, {kind: "complete"}>;
    } finally {
      try {await context.close();} finally {await interception?.close();}
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
  }
}

async function main(): Promise<void> {
  // Defense against accidental host execution, not an isolation attestation.
  if (process.env.ATTENTION_ISOLATED_READER !== "1" || process.getuid?.() !== 10001) throw new ProtocolError();
  const budget = new WireBudget();
  const decoder = new FrameDecoder(budget);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60_000);
  const send = async (frame: Frame): Promise<void> => {
    const bytes = encodeFrame(frame, budget);
    await new Promise<void>((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
  };
  const client = new ResourceClient(send);
  let rendering: Promise<void> | null = null;
  try {
    for await (const chunk of process.stdin) {
      for (const frame of decoder.push(chunk as Uint8Array)) {
        if (!rendering && frame.kind === "start") {
          rendering = runRenderer(frame, (url, type) => client.request(url, type), controller.signal)
            .then(result => send(result))
            .catch(async () => {await send({kind: "failed", code: "render_failed"});})
            .finally(() => {client.close(); process.stdin.destroy();});
          void rendering.catch(() => undefined);
        } else if (frame.kind === "resource_result" || frame.kind === "resource_error") client.receive(frame);
        else throw new ProtocolError();
      }
    }
    decoder.finish();
  } finally {
    controller.abort(); client.close();
    if (rendering) await rendering;
    clearTimeout(deadline);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {process.exitCode = 1;});
}
