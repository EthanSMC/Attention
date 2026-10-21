import { chromium, type BrowserContext, type Page } from "playwright";
import { resolve, dirname } from "node:path";
import { BrowserTaskError, MAX_BODY_BYTES, type BrowserGrant } from "./contracts.js";
import { allowedResource, sourcePolicy } from "./network-policy.js";
import { createEgressProxy } from "./egress-proxy.js";
import { bounded, type BrowserEngine, type BrowserPage } from "./task-manager.js";
import { ensurePrivateDirectory as secureDirectory } from "./account-authority.js";
import { installArticleRequestGate } from "./article-request-gate.js";

export class PlaywrightBrowserEngine implements BrowserEngine {
  private current: { context: BrowserContext; close(): Promise<void> } | null = null;
  constructor(private readonly attentionDirectory: string) {}

  async open(grant: BrowserGrant, signal: AbortSignal): Promise<BrowserPage> {
    if (process.platform !== "darwin") throw new BrowserTaskError("browser_unavailable");
    if (this.current) throw new BrowserTaskError("browser_busy");
    const root = resolve(this.attentionDirectory), browserRoot = resolve(root, "browser"), profile = resolve(browserRoot, "profile");
    if (dirname(profile) !== browserRoot) throw new BrowserTaskError("browser_unavailable");
    await secureDirectory(root); await secureDirectory(browserRoot); await secureDirectory(profile);
    const policy = sourcePolicy(grant.source_url);
    const proxy = await createEgressProxy(policy.hosts);
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let closed = false;
    let gate: Awaited<ReturnType<typeof installArticleRequestGate>> | null = null;
    const close = async () => {
      if (closed) return; closed = true;
      signal.removeEventListener("abort", abort);
      if (this.current?.close === close) this.current = null;
      try { await bounded(context?.close() ?? Promise.resolve(), AbortSignal.timeout(2000)); }
      finally { await proxy.close(); await gate?.close(); }
    };
    const abort = () => { void close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      context = await chromium.launchPersistentContext(profile, {
        headless: false, chromiumSandbox: true, proxy: proxy.proxy, acceptDownloads: false,
        serviceWorkers: "block", permissions: [], timeout: 20_000,
        args: ["--disable-quic", "--disable-background-networking", "--disable-extensions",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-sync"],
      });
      if (signal.aborted || closed) { await context.close(); signal.throwIfAborted(); throw new BrowserTaskError("cancelled"); }
      this.current = { context, close };
      await context.routeWebSocket("**/*", socket => socket.close());
      page = context.pages()[0] ?? await context.newPage();
      const active = page;
      context.on("page", other => { if (other !== active) void other.close().catch(() => {}); });
      for (const other of context.pages()) if (other !== active) await other.close();
      gate = await installArticleRequestGate(await context.newCDPSession(active), grant.source_url);
      active.on("download", download => { void download.cancel(); });
      active.on("dialog", dialog => { void dialog.dismiss(); });
      await active.goto(grant.source_url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      signal.throwIfAborted();
      // The open-action deadline must not close a verification page later.
      signal.removeEventListener("abort", abort);
      return {
        async read(readSignal) {
          readSignal.throwIfAborted();
          const url = active.url();
          if (!allowedResource(url, grant.source_url, true)) throw new BrowserTaskError("unsafe_source");
          const doc = await bounded(active.evaluate((maximum) => {
            const body = (document.body?.innerText ?? "").slice(0, 5000);
            const verificationRequired = location.pathname === "/mp/wappoc_appmsgcaptcha" ||
              /环境异常|完成验证|安全验证|访问过于频繁|请在微信客户端打开|captcha/i.test(body);
            const article = document.querySelector<HTMLElement>("#js_content, article, [itemprop='articleBody'], main");
            const title = (document.querySelector<HTMLElement>("#activity-name, h1")?.innerText ?? document.title).trim();
            const raw = article?.innerText ?? "";
            return { title, text: raw.slice(0, maximum), verificationRequired,
              complete: raw.length <= maximum && raw.trim().length >= 100 && Boolean(title) };
          }, MAX_BODY_BYTES), readSignal);
          return { ...doc, url };
        },
        async show(showSignal) { await bounded(active.bringToFront(), showSignal); },
        async scroll(scrollSignal) { await bounded(active.mouse.wheel(0, 700), scrollSignal); },
        close,
      };
    } catch (error) { await close().catch(() => {}); throw error; }
  }
  async close(): Promise<void> { await this.current?.close(); }
}
