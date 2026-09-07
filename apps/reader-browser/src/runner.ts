import { chromium, type Route, type BrowserType, type Page } from "playwright";
import { pathToFileURL } from "node:url";
import { FrameSchema, FrameDecoder, WireBudget, encodeFrame, ProtocolError, RESOURCE_TYPES,
  type Frame, type ResourceFrame, type ResourceReply } from "./protocol.js";

type RequestResource = (url: string, resourceType: ResourceFrame["resourceType"]) => Promise<ResourceReply>;
type ResourceRoute = {request(): {url(): string; method(): string; resourceType(): string};
  abort(): Promise<unknown>; fulfill(options: Parameters<Route["fulfill"]>[0]): Promise<unknown>};

export async function handleResourceRoute(route: ResourceRoute, request: RequestResource): Promise<void> {
  const source = route.request();
  const type = source.resourceType();
  if (source.method() !== "GET" || !RESOURCE_TYPES.some(allowed => allowed === type)) {
    await route.abort(); return;
  }
  try {
    const result = await request(source.url(), type as ResourceFrame["resourceType"]);
    if (result.kind === "resource_error") {await route.abort(); return;}
    if (result.finalUrl !== source.url()) {
      // Redirect every resource, including CSS/modules, to retain its base URL.
      await route.fulfill({status: 302, headers: {location: result.finalUrl}, body: ""});
    } else {
      await route.fulfill({status: result.status, contentType: result.contentType,
        body: Buffer.from(result.bodyBase64, "base64")});
    }
  } catch { await route.abort().catch(() => undefined); }
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
    try {
      let mainPage: Page | null = null;
      context.on("page", page => {if (mainPage && page !== mainPage) void page.close().catch(() => undefined);});
      await context.routeWebSocket("**/*", socket => socket.close());
      await context.route("**/*", async route => {
        // Popup and child-frame navigations have no reading purpose.
        const frame = route.request().frame();
        if (!mainPage || frame !== mainPage.mainFrame()) {await route.abort(); return;}
        await handleResourceRoute(route, request);
      });
      mainPage = await context.newPage();
      mainPage.on("download", download => {void download.cancel();});
      mainPage.on("dialog", dialog => {void dialog.dismiss();});
      const response = await mainPage.goto(start.url, {waitUntil: "domcontentloaded", timeout: 50_000});
      // Stop waiting when semantic content exists; short bounded settle for empty apps.
      await mainPage.waitForFunction(() => Boolean(document.querySelector("article, main, [itemprop='articleBody']")?.textContent?.trim()), undefined, {timeout: 5_000})
        .catch(() => undefined);
      signal.throwIfAborted();
      return FrameSchema.parse({kind: "complete", html: await mainPage.content(), finalUrl: mainPage.url(), status: response?.status() ?? 200}) as Extract<Frame, {kind: "complete"}>;
    } finally { await context.close(); }
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
