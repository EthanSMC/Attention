import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserMcpServer } from "./mcp-server";
import { BrowserTaskManager } from "./task-manager";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });
async function fixture() {
  const grant = { grant_id: "11111111-1111-4111-8111-111111111111", account_id: "22222222-2222-4222-8222-222222222222",
    collection_id: "33333333-3333-4333-8333-333333333333", source_url: "https://mp.weixin.qq.com/s/test",
    source_revision: "a".repeat(64), expires_at: Date.now() + 60_000 };
  let text = "完整正文".repeat(5000);
  let verification = false;
  const manager = new BrowserTaskManager({ resolve: async () => grant }, {
    open: async () => ({ read: async () => ({ url: grant.source_url, title: "标题", text, complete: true, verificationRequired: verification }),
      close: async () => {}, show: async () => {}, scroll: async () => {} }), close: async () => {},
  });
  const server = createBrowserMcpServer(manager), client = new Client({ name: "test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(local), client.connect(remote)]);
  closes.push(async () => { await manager.shutdown(); await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    if (name === "attention_browser_open_collection" && !Object.hasOwn(args, "url")) expect(result, JSON.stringify(result)).toHaveProperty("structuredContent.task_id");
    return { ...result, structuredContent: result.structuredContent as Record<string, unknown> | undefined };
  };
  return { call, client, setText: (value: string) => { text = value; }, setVerification: () => { verification = true; } };
}

it("advertises only bounded browser tools, and rejects arbitrary URL/script inputs", async () => {
  const { client, call } = await fixture();
  const { tools } = await client.listTools();
  expect(tools.map(tool => tool.name)).toEqual(["attention_browser_open_collection", "attention_browser_read_article",
    "attention_browser_status", "attention_browser_show", "attention_browser_scroll", "attention_browser_close"]);
  const result = await call("attention_browser_open_collection", { grant: "a".repeat(64), url: "file:///etc/passwd" });
  expect(result.isError).toBe(true);
});

it("pages actual evidence with SHA continuity, while status returns no evidence", async () => {
  const { call, setText } = await fixture();
  const opened = (await call("attention_browser_open_collection", { grant: "a".repeat(64) })).structuredContent!;
  const input = { task_id: opened.task_id };
  const first = (await call("attention_browser_read_article", input)).structuredContent!;
  const evidence = first.evidence as { text: string; sha256: string };
  expect(evidence.text.length).toBe(12000); expect(first.next_offset).toBe(12000);
  const second = (await call("attention_browser_read_article", { ...input, offset: 12000, expected_sha256: evidence.sha256 })).structuredContent!;
  expect(second.next_offset).toBeNull();
  expect((await call("attention_browser_status", input)).structuredContent).not.toHaveProperty("evidence");
  setText("新的正文".repeat(5000));
  expect((await call("attention_browser_read_article", { ...input, offset: 12000, expected_sha256: evidence.sha256 })).structuredContent)
    .toMatchObject({ error: { code: "source_changed" } });
});

it("does not expose verification page evidence or exception details", async () => {
  const { call, setVerification, setText } = await fixture();
  const opened = (await call("attention_browser_open_collection", { grant: "a".repeat(64) })).structuredContent!;
  setVerification(); setText("secret verification token");
  const result = await call("attention_browser_read_article", { task_id: opened.task_id });
  expect(result.structuredContent).toMatchObject({ status: "needs_user_verification" });
  expect(JSON.stringify(result)).not.toContain("secret");
});
