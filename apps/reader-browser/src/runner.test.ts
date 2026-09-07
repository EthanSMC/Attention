import { expect, it, vi } from "vitest";
import { handleResourceRoute, runRenderer, ResourceClient } from "./runner.js";
import type { Frame, ResourceReply } from "./protocol.js";

it.each(["document", "script", "stylesheet"])("redirects %s to its validated final URL without forwarding bytes", async (resourceType) => {
  const fulfill = vi.fn();
  const abort = vi.fn();
  const route = {request: () => ({method: () => "GET", resourceType: () => resourceType, url: () => "https://example.com/old"}), fulfill, abort};
  await handleResourceRoute(route, async () => ({kind: "resource_result", id: "1", status: 200, contentType: "text/html", bodyBase64: "c2VjcmV0", finalUrl: "https://cdn.example.com/path/new"}));
  expect(fulfill).toHaveBeenCalledWith({status: 302, headers: {location: "https://cdn.example.com/path/new"}, body: ""});
  expect(abort).not.toHaveBeenCalled();
});
it.each([["POST", "fetch"], ["GET", "image"], ["GET", "font"], ["GET", "media"], ["GET", "websocket"]])("blocks %s %s before relaying", async (method, resourceType) => {
  const request = vi.fn();
  const abort = vi.fn();
  await handleResourceRoute({request: () => ({method: () => method, resourceType: () => resourceType, url: () => "https://example.com/"}), abort, fulfill: vi.fn()}, request);
  expect(abort).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
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
  const page = {on: vi.fn(), goto: async () => ({status: () => 200}), waitForFunction: async () => undefined,
    content: async () => "<article><p>Controlled article emitted by fixture app.js.</p></article>", url: () => "https://example.com/article"};
  const context = {route: vi.fn(), routeWebSocket: vi.fn(), on: vi.fn(), newPage: async () => page,
    close: async () => {events.push("context closed");}};
  const launch = vi.fn(async () => ({newContext: async () => context, close: async () => {events.push("browser closed");}}));
  const result = await runRenderer({kind: "start", url: "https://example.com/article", sourceKind: "generic_web"}, async () => {throw new Error("unused");}, new AbortController().signal, {launch} as never);
  expect(result).toMatchObject({html: expect.stringContaining("Controlled article"), status: 200});
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({chromiumSandbox: true}));
  expect(events).toEqual(["context closed", "browser closed"]);
});
it("fulfills controlled HTML and JS fixture bytes without leaking upstream headers", async () => {
  const fixtures: Record<string, ResourceReply> = {
    "https://example.com/article": {kind: "resource_result", id: "1", status: 200, contentType: "text/html", finalUrl: "https://example.com/article", bodyBase64: Buffer.from('<div id="app"></div><script src="/app.js"></script>').toString("base64")},
    "https://example.com/app.js": {kind: "resource_result", id: "2", status: 200, contentType: "application/javascript", finalUrl: "https://example.com/app.js", bodyBase64: Buffer.from('document.querySelector("#app").innerHTML="<article><p>Controlled article.</p></article>"').toString("base64")},
  };
  for (const [url, reply] of Object.entries(fixtures)) {
    const fulfill = vi.fn();
    await handleResourceRoute({request: () => ({method: () => "GET", resourceType: () => url.endsWith(".js") ? "script" : "document", url: () => url}), fulfill, abort: vi.fn()}, async () => reply);
    expect(fulfill).toHaveBeenCalledWith({status: 200, contentType: reply.kind === "resource_result" ? reply.contentType : "", body: Buffer.from(reply.kind === "resource_result" ? reply.bodyBase64 : "", "base64")});
  }
});
