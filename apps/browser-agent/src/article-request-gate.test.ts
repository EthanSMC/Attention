import type { CDPSession } from "playwright";
import { expect, it, vi } from "vitest";
import { installArticleRequestGate } from "./article-request-gate";

it("checks each redirect, denies personal endpoints/POST/frames/private targets, and bounds requests", async () => {
  let paused!: (event: unknown) => void;
  const send = vi.fn(async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {});
  const session = { send, on: (_: string, listener: typeof paused) => { paused = listener; }, off: vi.fn() } as unknown as CDPSession;
  const source = "https://mp.weixin.qq.com/s/article";
  const gate = await installArticleRequestGate(session, source);
  const request = (id: string, url: string, type = "Document", method = "GET", frame = "main") => {
    paused({ requestId: id, frameId: frame, resourceType: type, request: { url, method } });
  };
  request("first", source);
  request("redirect", "https://mp.weixin.qq.com/account/private");
  request("private", "https://127.0.0.1/secret");
  request("post", source, "Document", "POST");
  request("frame", source, "Document", "GET", "child");
  request("xhr", "https://mp.weixin.qq.com/account/data", "XHR");
  request("asset", "https://res.wx.qq.com/article.js", "Script");
  for (let i = 0; i < 301; i++) request("budget" + i, source);
  await gate.close();
  expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "first" });
  expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "asset" });
  for (const requestId of ["redirect", "private", "post", "frame", "xhr", "budget300"])
    expect(send).toHaveBeenCalledWith("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
  expect(send).not.toHaveBeenCalledWith("Fetch.disable");
});
