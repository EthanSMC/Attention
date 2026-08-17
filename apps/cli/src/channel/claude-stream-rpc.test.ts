import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ClaudeStreamRpc,
  type ClaudeStreamRpcError,
  type ClaudeSpawnImplementation,
} from "./claude-stream-rpc";

function scriptedChild() {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const child = Object.assign(events, {
    kill: vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => events.emit("close", null, signal));
      return true;
    }),
    pid: 4_242,
    stderr,
    stdin,
    stdout,
  });
  return { child, events, stderr, stdout, writes };
}

describe("Claude stream-json transport", () => {
  it("starts one long-lived process and parses split JSONL messages", async () => {
    const fixture = scriptedChild();
    const spawnImpl = vi.fn(() => fixture.child) as unknown as ClaudeSpawnImplementation;
    const rpc = new ClaudeStreamRpc({
      args: ["-p", "--input-format", "stream-json"],
      cwd: "/tmp/channel",
      environment: { ATTENTION_TEST: "1" },
      spawnImpl,
    });
    const messages: unknown[] = [];
    rpc.onMessage((message) => messages.push(message));

    await rpc.start();
    fixture.stdout.write('{"type":"system","subtype":"init",');
    fixture.stdout.write('"session_id":"session-1"}\n');
    fixture.stdout.write('{"type":"assistant","message":{"content":[]}}\n');

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "claude",
      ["-p", "--input-format", "stream-json"],
      expect.objectContaining({
        cwd: "/tmp/channel",
        env: expect.objectContaining({
          ATTENTION_TEST: "1",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        }),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(messages).toEqual([
      { session_id: "session-1", subtype: "init", type: "system" },
      { message: { content: [] }, type: "assistant" },
    ]);
    expect(rpc.snapshot()).toMatchObject({
      phase: "running",
      pid: 4_242,
      stderr: "",
    });
    await rpc.close();
  });

  it("writes each user message as one JSON line without closing stdin", async () => {
    const fixture = scriptedChild();
    const rpc = new ClaudeStreamRpc({
      args: [],
      spawnImpl: (() => fixture.child) as unknown as ClaudeSpawnImplementation,
    });
    await rpc.start();

    rpc.send({
      message: { content: [{ text: "你好", type: "text" }], role: "user" },
      type: "user",
    });
    rpc.send({
      message: { content: [{ text: "继续", type: "text" }], role: "user" },
      type: "user",
    });

    expect(fixture.writes.join("")).toBe(
      '{"message":{"content":[{"text":"你好","type":"text"}],"role":"user"},"type":"user"}\n' +
        '{"message":{"content":[{"text":"继续","type":"text"}],"role":"user"},"type":"user"}\n',
    );
    expect(rpc.snapshot().phase).toBe("running");
    await rpc.close();
  });

  it("fails closed on malformed protocol output", async () => {
    const fixture = scriptedChild();
    const rpc = new ClaudeStreamRpc({
      args: [],
      spawnImpl: (() => fixture.child) as unknown as ClaudeSpawnImplementation,
    });
    await rpc.start();
    fixture.stdout.write("not-json\n");

    await expect(rpc.waitForExit()).resolves.toMatchObject({
      phase: "stopped",
    });
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(rpc.snapshot().lastErrorCode).toBe("protocol_error");
  });

  it("rejects writes when the process is not running", () => {
    const rpc = new ClaudeStreamRpc({ args: [] });
    expect(() => rpc.send({ type: "user" })).toThrowError(
      expect.objectContaining<Partial<ClaudeStreamRpcError>>({
        code: "not_running",
      }),
    );
  });

  it("captures bounded stderr and closes gracefully", async () => {
    const fixture = scriptedChild();
    const rpc = new ClaudeStreamRpc({
      args: [],
      spawnImpl: (() => fixture.child) as unknown as ClaudeSpawnImplementation,
    });
    await rpc.start();
    fixture.stderr.write("diagnostic\n");
    await rpc.close();

    expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(rpc.snapshot()).toMatchObject({
      phase: "stopped",
      stderr: "diagnostic\n",
    });
  });
});
