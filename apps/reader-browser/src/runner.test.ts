import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { CDPSession } from "playwright";
import { installResourceInterception, runRenderer, ResourceClient } from "./runner.js";
import type { Frame, ResourceReply } from "./protocol.js";

class SyntheticCdp extends EventEmitter {
  asSession(): CDPSession {return this as unknown as CDPSession;}
  commands: Array<{method: string; params: unknown}> = [];
  async send(method: string, params?: unknown) {
    this.commands.push({method, params});
    if (method === "Page.getFrameTree") return {frameTree: {frame: {id: "main-frame"}}};
    return {};
  }
}

it.each(["Document", "Script", "Stylesheet"])("brokers the redirected %s requestPaused event through the same bounded client", async (resourceType) => {
  const session = new SyntheticCdp();
  const requests: Frame[] = [];
  const client = new ResourceClient(async frame => {requests.push(frame);});
  const interception = await installResourceInterception(session.asSession(), (url, type) => client.request(url, type));
  expect(session.commands).toContainEqual({method: "Fetch.enable", params: {patterns: [{urlPattern: "*", requestStage: "Request"}], handleAuthRequests: true}});
  session.emit("Fetch.requestPaused", {requestId: "first", frameId: "main-frame", resourceType, request: {url: "https://example.com/old", method: "GET"}});
  expect(requests).toEqual([{kind: "resource", id: "1", url: "https://example.com/old", resourceType: resourceType.toLowerCase()}]);
  client.receive({kind: "resource_result", id: "1", status: 200, contentType: "text/plain", bodyBase64: "b2xk", finalUrl: "https://example.com/new/base"});
  await vi.waitFor(() => expect(session.commands).toContainEqual({method: "Fetch.fulfillRequest", params: {requestId: "first", responseCode: 302, responseHeaders: [{name: "Location", value: "https://example.com/new/base"}], body: ""}}));
  session.emit("Fetch.requestPaused", {requestId: "second", redirectedRequestId: "first", frameId: "main-frame", resourceType, request: {url: "https://example.com/new/base", method: "GET"}});
  expect(requests[1]).toMatchObject({id: "2", url: "https://example.com/new/base"});
  client.receive({kind: "resource_result", id: "2", status: 200, contentType: "text/plain", bodyBase64: "bmV3", finalUrl: "https://example.com/new/base"});
  await vi.waitFor(() => expect(session.commands).toContainEqual({method: "Fetch.fulfillRequest", params: {requestId: "second", responseCode: 200, responseHeaders: [{name: "Content-Type", value: "text/plain"}], body: "bmV3"}}));
  expect(session.commands.map(command => command.method)).not.toContain("Fetch.continueRequest");
  await interception.close(); client.close();
  expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
});

it("denies CDP child frames, POST, unsupported resource types, and auth without forwarding them", async () => {
  const session = new SyntheticCdp();
  const request = vi.fn();
  const interception = await installResourceInterception(session.asSession(), request);
  for (const [requestId, frameId, resourceType, method] of [["1", "child", "Document", "GET"], ["2", "main-frame", "Fetch", "POST"], ["3", "main-frame", "Image", "GET"]]) {
    session.emit("Fetch.requestPaused", {requestId, frameId, resourceType, request: {url: "https://example.com/", method}});
  }
  session.emit("Fetch.authRequired", {requestId: "auth"});
  await vi.waitFor(() => expect(session.commands.filter(command => command.method === "Fetch.failRequest")).toHaveLength(3));
  expect(session.commands).toContainEqual({method: "Fetch.continueWithAuth", params: {requestId: "auth", authChallengeResponse: {response: "CancelAuth"}}});
  expect(request).not.toHaveBeenCalled();
  await interception.close();
});

it.each([["POST", "Fetch"], ["GET", "Image"], ["GET", "Font"], ["GET", "Media"], ["GET", "WebSocket"]])("blocks %s %s before relaying", async (method, resourceType) => {
  const session = new SyntheticCdp();
  const request = vi.fn();
  const interception = await installResourceInterception(session.asSession(), request);
  session.emit("Fetch.requestPaused", {requestId: "1", frameId: "main-frame", resourceType, request: {url: "https://example.com/", method}});
  await vi.waitFor(() => expect(session.commands).toContainEqual({method: "Fetch.failRequest", params: {requestId: "1", errorReason: "BlockedByClient"}}));
  expect(request).not.toHaveBeenCalled();
  await interception.close();
});
it("correlates broker replies and blocks duplicate/unsolicited IDs", async () => {
  const frames: Frame[] = [];
  const client = new ResourceClient(async frame => {frames.push(frame);});
  const reply = client.request("https://example.com/app.js", "script");
  expect(frames).toEqual([{kind: "resource", id: "1", url: "https://example.com/app.js", resourceType: "script"}]);
  client.receive({kind: "resource_error", id: "1", code: "blocked"});
  expect(await reply).toMatchObject({code: "blocked"});
  expect(() => client.receive({kind: "resource_error", id: "1", code: "blocked"})).toThrow();
  client.close();
});
it("never exceeds four requests when a new arrival races a queued waiter", async () => {
  const frames: Frame[] = [];
  const client = new ResourceClient(async frame => {frames.push(frame);});
  const pending = Array.from({length: 5}, () => client.request("https://example.com/app.js", "script"));
  client.receive({kind: "resource_error", id: "1", code: "blocked"});
  pending.push(client.request("https://example.com/app.js", "script"));
  await Promise.resolve();
  expect(frames).toHaveLength(5);
  client.close();
  await Promise.allSettled(pending);
});
it("runs the runner lifecycle on a controlled fixture and closes context/browser", async () => {
  const events: string[] = [];
  const session = new SyntheticCdp();
  const page = {on: vi.fn(), goto: async () => {
    expect(session.commands).toContainEqual({method: "Fetch.enable", params: {patterns: [{urlPattern: "*", requestStage: "Request"}], handleAuthRequests: true}});
    return {status: () => 200};
  }, waitForFunction: async () => undefined,
    content: async () => "<article><p>Controlled article emitted by fixture app.js.</p></article>", url: () => "https://example.com/article"};
  const context = {route: vi.fn(() => {throw new Error("Competing Playwright HTTP router");}), routeWebSocket: vi.fn(), on: vi.fn(), newPage: async () => page,
    newCDPSession: async () => session.asSession(),
    close: async () => {events.push("context closed");}};
  const launch = vi.fn(async () => ({newContext: async () => context, close: async () => {events.push("browser closed");}}));
  const result = await runRenderer({kind: "start", url: "https://example.com/article", sourceKind: "generic_web"}, async () => {throw new Error("unused");}, new AbortController().signal, {launch} as never);
  expect(result).toMatchObject({html: expect.stringContaining("Controlled article"), status: 200});
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({chromiumSandbox: true}));
  expect(events).toEqual(["context closed", "browser closed"]);
  expect(context.route).not.toHaveBeenCalled();
  expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
});
it("fulfills controlled HTML and JS fixture bytes without leaking upstream headers", async () => {
  const fixtures: Record<string, ResourceReply> = {
    "https://example.com/article": {kind: "resource_result", id: "1", status: 200, contentType: "text/html", finalUrl: "https://example.com/article", bodyBase64: Buffer.from('<div id="app"></div><script src="/app.js"></script>').toString("base64")},
    "https://example.com/app.js": {kind: "resource_result", id: "2", status: 200, contentType: "application/javascript", finalUrl: "https://example.com/app.js", bodyBase64: Buffer.from('document.querySelector("#app").innerHTML="<article><p>Controlled article.</p></article>"').toString("base64")},
  };
  for (const [url, reply] of Object.entries(fixtures)) {
    const session = new SyntheticCdp();
    const interception = await installResourceInterception(session.asSession(), async () => reply);
    session.emit("Fetch.requestPaused", {requestId: "1", frameId: "main-frame", resourceType: url.endsWith(".js") ? "Script" : "Document", request: {url, method: "GET"}});
    await vi.waitFor(() => expect(session.commands).toContainEqual({method: "Fetch.fulfillRequest", params: {requestId: "1", responseCode: 200,
      responseHeaders: [{name: "Content-Type", value: reply.kind === "resource_result" ? reply.contentType : ""}], body: reply.kind === "resource_result" ? reply.bodyBase64 : ""}}));
    await interception.close();
  }
});
