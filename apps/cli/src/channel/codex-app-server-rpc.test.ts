import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CodexAppServerRpc } from "./codex-app-server-rpc";

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  });
  #stdin = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.#stdin += chunk.toString("utf8");
    });
  }

  messages(): Array<Record<string, unknown>> {
    return this.#stdin
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function createRpc(child = new FakeChild(), requestTimeoutMs = 1_000) {
  return {
    child,
    rpc: new CodexAppServerRpc({
      args: ["app-server", "--stdio"],
      requestTimeoutMs,
      spawnImpl: () => child as never,
    }),
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("CodexAppServerRpc", () => {
  it("correlates responses while forwarding interleaved notifications", async () => {
    const { child, rpc } = createRpc();
    const notifications: string[] = [];
    rpc.onNotification((event) => notifications.push(event.method));
    await rpc.start();

    const pending = rpc.request<{ serverName: string }>("initialize", {
      capabilities: null,
      clientInfo: {
        name: "attention-channel",
        title: "Attention",
        version: "0.1.0",
      },
    });
    await nextTurn();
    const request = child.messages()[0];
    child.send({
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    });
    child.send({
      id: request?.id,
      result: { serverName: "codex-app-server" },
    });

    await expect(pending).resolves.toEqual({
      serverName: "codex-app-server",
    });
    expect(notifications).toEqual(["thread/started"]);
    expect(rpc.snapshot()).toMatchObject({ phase: "running", pid: 4242 });
    await rpc.close();
  });

  it("declines command and file approvals without consulting a model", async () => {
    const { child, rpc } = createRpc();
    await rpc.start();

    child.send({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { itemId: "item-1", threadId: "t", turnId: "u" },
    });
    child.send({
      id: 92,
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-2", threadId: "t", turnId: "u" },
    });
    await nextTurn();

    expect(child.messages()).toEqual([
      { id: 91, result: { decision: "decline" } },
      { id: 92, result: { decision: "decline" } },
    ]);
    await rpc.close();
  });

  it("rejects every other server request as unsupported", async () => {
    const { child, rpc } = createRpc();
    await rpc.start();
    child.send({
      id: 93,
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });
    await nextTurn();

    expect(child.messages()).toEqual([
      {
        error: { code: -32601, message: "Method not supported" },
        id: 93,
      },
    ]);
    await rpc.close();
  });

  it("times out one request without terminating the resident process", async () => {
    vi.useFakeTimers();
    const { rpc } = createRpc(new FakeChild(), 50);
    await rpc.start();
    const pending = rpc.request("thread/start", {});
    const rejected = expect(pending).rejects.toMatchObject({
      code: "request_timeout",
    });
    await vi.advanceTimersByTimeAsync(51);

    await rejected;
    expect(rpc.snapshot().phase).toBe("running");
    await rpc.close();
    vi.useRealTimers();
  });

  it("rejects all pending requests when the child exits", async () => {
    const { child, rpc } = createRpc();
    await rpc.start();
    const first = rpc.request("thread/start", {});
    const second = rpc.request("turn/start", {});
    child.emit("close", 23, null);

    await expect(first).rejects.toMatchObject({ code: "process_exited" });
    await expect(second).rejects.toMatchObject({ code: "process_exited" });
    expect(rpc.snapshot()).toMatchObject({ exitCode: 23, phase: "stopped" });
  });

  it("treats malformed stdout as a protocol failure", async () => {
    const { child, rpc } = createRpc();
    await rpc.start();
    const pending = rpc.request("initialize", {});
    child.stdout.write("not-json\n");

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        code: "protocol_error",
      }),
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
