import type { CDPSession } from "playwright";
import { allowedResource } from "./network-policy.js";

interface Paused { requestId: string; frameId: string; resourceType: string; request: { url: string; method: string } }
const types = new Set(["Document", "Script", "Stylesheet", "Image", "Font", "XHR", "Fetch"]);

/** Request-stage CDP events include redirects; a Playwright route by itself
 * does not validate every redirect hop before cookies/headers are sent. */
export async function installArticleRequestGate(session: CDPSession, source: string) {
  const { frameTree } = await session.send("Page.getFrameTree");
  const pending = new Set<Promise<void>>();
  let count = 0;
  const handle = async (event: Paused) => {
    try {
      const navigation = event.resourceType === "Document";
      const boundedFetch = event.resourceType === "XHR" || event.resourceType === "Fetch";
      const permitted = ++count <= 300 && event.frameId === frameTree.frame.id && event.request.method === "GET" &&
        types.has(event.resourceType) && allowedResource(event.request.url, source, navigation || boundedFetch);
      await session.send(permitted ? "Fetch.continueRequest" : "Fetch.failRequest", permitted ?
        { requestId: event.requestId } : { requestId: event.requestId, errorReason: "BlockedByClient" });
    } catch { await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {}); }
  };
  const paused = (event: Paused) => {
    const operation = handle(event); pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  session.on("Fetch.requestPaused", paused);
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  return {
    // Close the browser context first. Never disable Fetch on a live page,
    // which could release an in-flight blocked request to the network.
    async close() { session.off("Fetch.requestPaused", paused); await Promise.allSettled(pending); },
  };
}
