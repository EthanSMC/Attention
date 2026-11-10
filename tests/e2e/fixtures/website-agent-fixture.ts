import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Page, Route } from "@playwright/test";
import type { NextConfig } from "../../../apps/web/node_modules/next";
import type { WebsiteAgentActionView } from "../../../apps/web/src/server/website-agent-action-state";
// Reuse the workspace's existing, lockfile-pinned build tool. No new dependency.
import { build } from "../../../apps/cli/node_modules/esbuild/lib/main.js";

export const origin = "https://attention-ui.example.test";
export const sessionPath = "/api/website-agent/sessions";
export const queryPath = "/api/website-agent/query";
export const fixtureTime = Date.parse("2026-11-10T12:00:00.000Z");

export interface SessionView {
  id: string;
  revision: number;
  status: "open" | "closed" | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  pending: { query: string; runId: string; deadline: string } | null;
  actions?: WebsiteAgentActionView[];
}

export interface ApiCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface FetchObservation {
  path: string;
  method: string;
  aborted: boolean;
}

export function session(number: number, patch: Partial<SessionView> = {}): SessionView {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    revision: 1,
    status: "open",
    createdAt: new Date(fixtureTime - number * 60_000).toISOString(),
    updatedAt: new Date(fixtureTime).toISOString(),
    expiresAt: new Date(fixtureTime + 7 * 86_400_000).toISOString(),
    messages: [],
    pending: null,
    ...patch,
  };
}

export function pendingSession(number: number, patch: Partial<SessionView> = {}): SessionView {
  return session(number, {
    pending: {
      query: "Synthetic request already running",
      runId: `synthetic-run-${number}`,
      deadline: new Date(fixtureTime + 120_000).toISOString(),
    },
    ...patch,
  });
}

export function reviewedAction(number: number, patch: Partial<WebsiteAgentActionView> = {}): WebsiteAgentActionView {
  return {
    id: `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    toolName: "attention_update_collection",
    argumentsHash: number.toString(16).padStart(64, "0"),
    expiresAt: new Date(fixtureTime + 300_000).toISOString(),
    status: "pending",
    review: {
      title: `Synthetic reviewed change ${number}`,
      details: [
        { label: "目标", value: `Synthetic collection ${number}` },
        { label: "收藏 ID", value: `20000000-0000-4000-8000-${String(number).padStart(12, "0")}` },
        { label: "修改后可见性", value: "私密" },
      ],
      consequences: ["This exact collection will become private.", "Already completed changes are not automatically undone."],
    },
    receipt: null,
    ...patch,
  };
}

export function actionPath(sessionId: string, actionId: string, operation: "approve" | "decline" | "select") {
  return `${sessionPath}/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(actionId)}/${operation}`;
}

let documentPromise: Promise<string> | undefined;

/** Mount the unchanged production component, including real Next Link and CSS.
 * Only the surrounding test controls and HTTP responses are synthetic.
 */
export function componentDocument(): Promise<string> {
  documentPromise ??= (async () => {
    // Compile the TS config separately: Next owns it as a mixed-module package,
    // so importing it through Playwright's TS loader creates a require/ESM cycle.
    const configUrl = new URL("../../../apps/web/next.config.ts", import.meta.url);
    const configBuild = await build({
      entryPoints: [fileURLToPath(configUrl)], bundle: true, write: false,
      platform: "node", format: "esm",
      define: { "import.meta.url": JSON.stringify(configUrl.href) },
    });
    const configOutput = configBuild.outputFiles?.[0];
    if (!configOutput) throw new Error("The actual Next browser config is missing");
    const configDataUrl = `data:text/javascript;base64,${Buffer.from(configOutput.contents).toString("base64")}`;
    const { default: nextConfig } = await import(configDataUrl) as { default: NextConfig };
    const web = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
    const result = await build({
      stdin: {
        resolveDir: web,
        sourcefile: "website-agent-browser-fixture.tsx",
        loader: "tsx",
        contents: `
          import { createElement } from "react";
          import { createRoot } from "react-dom/client";
          import { WebsiteAgentConsole } from "./src/components/website-agent-console";

          // Observe actual AbortSignals without changing fetch or cancellation semantics.
          const observations = [];
          const log = document.getElementById("fixture-fetch-log");
          const nativeFetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const record = {
              path: new URL(typeof input === "string" ? input : input.url, location.href).pathname,
              method: init?.method ?? "GET", aborted: init?.signal?.aborted ?? false,
            };
            observations.push(record);
            const publish = () => { log.textContent = JSON.stringify(observations); };
            init?.signal?.addEventListener("abort", () => { record.aborted = true; publish(); }, { once: true });
            publish();
            return nativeFetch(input, init);
          };
          const root = createRoot(document.getElementById("fixture-root"));
          root.render(createElement(WebsiteAgentConsole));
          document.getElementById("fixture-unmount").addEventListener("click", () => root.unmount());
        `,
      },
      bundle: true,
      metafile: true,
      write: false,
      minify: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      target: "chrome130",
      // Next normally substitutes these browser-only Link settings at build time.
      // Read the real config rather than stubbing Link or exposing process.env.
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.__NEXT_ROUTER_BASEPATH": JSON.stringify(nextConfig.basePath ?? ""),
        "process.env.__NEXT_I18N_SUPPORT": JSON.stringify(Boolean(nextConfig.i18n)),
        "process.env.__NEXT_TRAILING_SLASH": JSON.stringify(nextConfig.trailingSlash ?? false),
        "process.env.__NEXT_MANUAL_TRAILING_SLASH": JSON.stringify(nextConfig.skipTrailingSlashRedirect ?? false),
        "process.env.__NEXT_MANUAL_CLIENT_BASE_PATH": JSON.stringify(nextConfig.experimental?.manualClientBasePath ?? false),
        "process.env.__NEXT_LINK_NO_TOUCH_START": JSON.stringify(nextConfig.experimental?.linkNoTouchStart ?? false),
      },
    });
    const javascript = result.outputFiles?.[0]?.text;
    if (!javascript) throw new Error("The actual component browser bundle is empty");
    if (!result.metafile) throw new Error("Browser bundle input provenance is missing");
    const serverInputs = Object.keys(result.metafile.inputs).filter(path => /(?:^|\/)src\/server\//u.test(path));
    if (serverInputs.length) {
      throw new Error(`Server implementation entered the browser fixture: ${serverInputs.join(", ")}`);
    }
    if (/\bprocess\.env\b/u.test(javascript)) {
      throw new Error("The browser fixture needs a newly introduced Next compile-time setting");
    }
    const css = await readFile(new URL("../../../apps/web/src/app/globals.css", import.meta.url), "utf8");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Attention synthetic component acceptance</title><style>${css}</style></head>
      <body><main><div class="page-shell page-shell--form"><h1>Attention 网页助手</h1>
      <div id="fixture-root"></div></div></main>
      <button id="fixture-unmount" type="button">Unmount test component</button>
      <output id="fixture-fetch-log" hidden>[]</output>
      <script>${javascript.replaceAll("</script", "<\\/script")}</script></body></html>`;
  })();
  return documentPromise;
}

type RouteHandler = (route: Route, call: ApiCall) => Promise<void>;

export interface HeldRequest {
  received: Promise<ApiCall>;
  respond: (json: unknown, options?: { clientAborted?: boolean }) => Promise<void>;
}

export class SyntheticWebsiteApi {
  readonly calls: ApiCall[] = [];
  readonly unexpectedRequests: string[] = [];
  readonly sessions = new Map<string, SessionView>();
  listedIds: string[] = [];
  private handlers = new Map<string, RouteHandler[]>();
  private nextId = 100;

  seed(views: SessionView[], listedIds = views.map(view => view.id)): void {
    this.sessions.clear();
    for (const view of views) this.sessions.set(view.id, structuredClone(view));
    this.listedIds = [...listedIds];
  }

  count(method: string, path: string): number {
    return this.calls.filter(call => call.method === method && call.path === path).length;
  }

  private enqueue(method: string, path: string, handler: RouteHandler): void {
    const key = `${method} ${path}`;
    this.handlers.set(key, [...(this.handlers.get(key) ?? []), handler]);
  }

  replyNext(method: string, path: string, json: unknown, status = 200): void {
    this.enqueue(method, path, route => route.fulfill({ status, json }));
  }

  failNext(method: string, path: string): void {
    this.enqueue(method, path, route => route.abort("failed"));
  }

  holdNext(method: string, path: string): HeldRequest {
    let pendingRoute: Route | undefined;
    let receive: (call: ApiCall) => void = () => {};
    const received = new Promise<ApiCall>(resolve => { receive = resolve; });
    this.enqueue(method, path, async (route, call) => {
      pendingRoute = route;
      receive(call);
    });
    return {
      received,
      async respond(json, { clientAborted = false } = {}) {
        await received;
        if (!pendingRoute) throw new Error("Held request was not captured");
        try {
          await pendingRoute.fulfill({ json });
        } catch (error) {
          // Tests first observe the real AbortSignal. A canceled route may no longer
          // accept a response; this is not a successful delivery claim.
          if (!clientAborted) throw error;
        }
      },
    };
  }

  async install(page: Page): Promise<void> {
    const html = await componentDocument();
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === "/agent/website" && request.method() === "GET") {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
        return;
      }
      if (url.origin === origin && url.pathname === "/favicon.ico") {
        await route.fulfill({ status: 204 });
        return;
      }
      if (url.origin !== origin || !url.pathname.startsWith("/api/website-agent/")) {
        this.unexpectedRequests.push(`${request.method()} ${request.url()}`);
        await route.abort("blockedbyclient");
        return;
      }
      const call: ApiCall = {
        method: request.method(),
        path: url.pathname,
        body: request.postData() ? request.postDataJSON() as Record<string, unknown> : null,
      };
      this.calls.push(call);
      const handler = this.handlers.get(`${call.method} ${call.path}`)?.shift();
      if (handler) { await handler(route, call); return; }
      if (call.path === sessionPath && call.method === "GET") {
        const summaries = this.listedIds.map(id => this.sessions.get(id)).filter(view => view !== undefined)
          .map(({ id, revision, status, createdAt, updatedAt, expiresAt }) => ({ id, revision, status, createdAt, updatedAt, expiresAt }));
        await route.fulfill({ json: { sessions: summaries } });
        return;
      }
      if (call.path === sessionPath && call.method === "POST") {
        const view = session(this.nextId++);
        this.sessions.set(view.id, view); this.listedIds.unshift(view.id);
        await route.fulfill({ json: { session: view } });
        return;
      }
      const detail = call.path.match(/^\/api\/website-agent\/sessions\/([^/]+)(\/close)?$/u);
      const view = detail?.[1] ? this.sessions.get(decodeURIComponent(detail[1])) : undefined;
      if (detail && !view) {
        await route.fulfill({ status: 404, json: { error: { code: "session_not_found" } } });
        return;
      }
      if (view && call.method === "GET" && !detail?.[2]) {
        await route.fulfill({ json: { session: view } });
        return;
      }
      if (view && call.method === "POST" && detail?.[2] === "/close") {
        if (call.body?.expected_revision !== view.revision) {
          await route.fulfill({ status: 409, json: { error: { code: "session_conflict" } } });
          return;
        }
        const closed: SessionView = { ...view, status: "closed", pending: null, revision: view.revision + 1 };
        this.sessions.set(view.id, closed);
        await route.fulfill({ json: { session: closed } });
        return;
      }
      this.unexpectedRequests.push(`${call.method} ${call.path}`);
      await route.fulfill({ status: 500, json: { error: { code: "unconfigured_synthetic_request" } } });
    });
  }
}

export function queryReply(view: SessionView, query = "Synthetic question", answer = "Synthetic grounded answer") {
  return {
    answer,
    session: {
      ...view,
      revision: view.revision + 1,
      pending: null,
      messages: [...view.messages, { role: "user", text: query }, { role: "assistant", text: answer }],
    } satisfies SessionView,
    usage: { modelCalls: 1, toolCalls: 0, observedCostMicrousd: 1 },
  };
}

export async function fetchObservations(page: Page): Promise<FetchObservation[]> {
  return page.locator("#fixture-fetch-log").evaluate(element => JSON.parse(element.textContent ?? "[]") as FetchObservation[]);
}
