import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { agentReachDockerRuntime, runAgentReachProcess } from "./agent-reach-process";

const image = `attention/agent-reach@sha256:${"a".repeat(64)}`;
const id = "b".repeat(64);
const host = agentReachDockerRuntime().host;
function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => process.emit("close", null)); return true; }),
  });
  return process as typeof process & ChildProcessWithoutNullStreams;
}
function completed(output = "", code = 0) {
  const process = child();
  queueMicrotask(() => { process.emit("spawn"); process.stdout.write(output); process.emit("close", code); });
  return process;
}
function nameOf(args: string[]) { return args[args.indexOf("--name") + 1]!; }

describe("isolated Agent-Reach transport", () => {
  it("uses the official macOS user runtime without a system socket or inherited context", () => {
    expect(agentReachDockerRuntime("darwin", "/Users/example")).toEqual({
      executable: "/Applications/Docker.app/Contents/Resources/bin/docker",
      host: ["--host", "unix:///Users/example/.docker/run/docker.sock"],
    });
    expect(agentReachDockerRuntime("linux", "/home/example")).toEqual({
      executable: "docker", host: ["--host", "unix:///var/run/docker.sock"],
    });
  });
  it("creates before starting and uses only stdin, a digest-pinned image and clean environment", async () => {
    const create = child(), reader = child();
    const spawn = vi.fn().mockReturnValueOnce(create).mockReturnValueOnce(reader).mockImplementationOnce(() => completed());
    const result = runAgentReachProcess('{"url":"https://public.example/article"}', image,
      new AbortController().signal, { spawn });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const [args, env] = spawn.mock.calls[0]! as [string[], NodeJS.ProcessEnv];
    expect(args).toEqual(expect.arrayContaining(["create", "--pull=never", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--user=65532:65532", "--network=bridge", "--log-driver=none", image]));
    expect(args.join(" ")).not.toContain("public.example");
    expect(args.some(value => value.includes("mount") || value === "-v" || value === "--privileged")).toBe(false);
    expect(Object.keys(env).sort()).toEqual(["DOCKER_CONFIG", "HOME", "PATH"]);
    expect(env.HOME).toBe(env.DOCKER_CONFIG);
    expect(create.stdin.read()).toBeNull();
    create.stdout.write(id); create.emit("close", 0);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn.mock.calls[1]![0]).toEqual([...host, "start", "--attach", "--interactive", nameOf(args)]);
    expect(reader.stdin.read().toString()).toContain("public.example");
    reader.stderr.write("private diagnostic ignored");
    reader.stdout.write('{"outcome":"ok"}'); reader.emit("close", 0);
    await expect(result).resolves.toEqual({ outcome: "ok" });
    expect(spawn.mock.calls[2]![0]).toEqual([...host, "rm", "--force", nameOf(args)]);
  });

  it("accepts an immutable locally built image ID without a registry or pull", async () => {
    const imageId = `sha256:${"c".repeat(64)}`;
    const spawn = vi.fn().mockImplementationOnce(() => completed(id))
      .mockImplementationOnce(() => completed('{}')).mockImplementationOnce(() => completed());
    await expect(runAgentReachProcess("{}", imageId, new AbortController().signal, { spawn })).resolves.toEqual({});
    expect(spawn.mock.calls[0]![0]).toEqual(expect.arrayContaining(["--pull=never", imageId]));
  });

  it.each(["attention/agent-reach:latest", "--privileged", "image@sha256:short"])("rejects unpinned image %s without starting a process", async value => {
    const spawn = vi.fn();
    await expect(runAgentReachProcess("{}", value, new AbortController().signal, { spawn }))
      .rejects.toMatchObject({ code: "reader_not_configured" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when canceled while preparing its directory", async () => {
    const controller = new AbortController(), spawn = vi.fn();
    const result = runAgentReachProcess("{}", image, controller.signal, { spawn });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["timeout", "abort", "overflow"])("terminates and removes only its named container on %s", async mode => {
    const reader = child(), controller = new AbortController();
    const spawn = vi.fn().mockImplementationOnce(() => completed(id)).mockReturnValueOnce(reader)
      .mockImplementationOnce(() => completed());
    const result = runAgentReachProcess("{}", image, controller.signal, { spawn, timeoutMs: mode === "timeout" ? 150 : 30_000 });
    const rejection = expect(result).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    if (mode === "abort") controller.abort();
    if (mode === "overflow") reader.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
    await rejection;
    expect(reader.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(3);
    const args = spawn.mock.calls[0]![0] as string[];
    expect(spawn.mock.calls[2]![0]).toEqual([...host, "rm", "--force", nameOf(args)]);
  });

  it("never starts an interrupted create, including an abort before its spawn event", async () => {
    const create = child(), controller = new AbortController();
    const spawn = vi.fn().mockReturnValueOnce(create).mockImplementationOnce(() => completed());
    const result = runAgentReachProcess("{}", image, controller.signal, { spawn });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort(); await rejection;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls.some(([args]) => (args as string[]).includes("start"))).toBe(false);
    expect(create.stdin.read()).toBeNull();
  });

  it("reports uncertainty if an interrupted create is not yet visible at the daemon", async () => {
    const create = child(), controller = new AbortController();
    const spawn = vi.fn().mockReturnValueOnce(create).mockImplementationOnce(() => completed("", 1))
      .mockImplementationOnce(() => completed());
    const result = runAgentReachProcess("{}", image, controller.signal, { spawn });
    const rejection = expect(result).rejects.toMatchObject({ message: "agent_reach_cleanup_unconfirmed", cleanupUnconfirmed: true });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort(); await rejection;
    expect(spawn.mock.calls.some(([args]) => (args as string[]).includes("start"))).toBe(false);
  });

  it.each(["nonzero", "spawn-error", "timeout"])("does not swallow a %s cleanup failure", async mode => {
    const cleaner = child();
    const spawn = vi.fn().mockImplementationOnce(() => completed(id)).mockImplementationOnce(() => completed('{}'))
      .mockImplementationOnce(() => {
        if (mode === "spawn-error") throw new Error("SECRET daemon credential");
        return mode === "nonzero" ? completed("", 1) : cleaner;
      }).mockImplementationOnce(() => completed("attention-agent-reach-still-present"));
    await expect(runAgentReachProcess("{}", image, new AbortController().signal, { spawn, cleanupTimeoutMs: 10 }))
      .rejects.toMatchObject({ message: "agent_reach_cleanup_unconfirmed", cleanupUnconfirmed: true });
    if (mode === "timeout") expect(cleaner.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("accepts auto-removal only after a successful generated-name absence check", async () => {
    const spawn = vi.fn().mockImplementationOnce(() => completed(id)).mockImplementationOnce(() => completed('{}'))
      .mockImplementationOnce(() => completed("", 1)).mockImplementationOnce(() => completed());
    await expect(runAgentReachProcess("{}", image, new AbortController().signal, { spawn })).resolves.toEqual({});
    const name = nameOf(spawn.mock.calls[0]![0] as string[]);
    expect(spawn.mock.calls[3]![0]).toEqual([...host, "container", "ls", "--all",
      "--filter", `name=${name}`, "--format", "{{.Names}}"]);
  });

  it("uses distinct names and temporary environments for concurrent attempts", async () => {
    const spawn = vi.fn((args: string[], _env: NodeJS.ProcessEnv) => completed(args[2] === "create" ? id : args[2] === "start" ? '{}' : ""));
    await Promise.all([0, 1].map(() => runAgentReachProcess("{}", image, new AbortController().signal, { spawn })));
    const creates = spawn.mock.calls.filter(([args]) => args[2] === "create");
    expect(new Set(creates.map(([args]) => nameOf(args))).size).toBe(2);
    expect(new Set(creates.map(([, env]) => env.HOME)).size).toBe(2);
    for (const [args] of creates) {
      expect(spawn.mock.calls.some(([cleanup]) => cleanup[2] === "rm" && cleanup.at(-1) === nameOf(args))).toBe(true);
    }
  });

  it("fails closed on missing runtime, failed create and invalid JSON without forwarding diagnostics", async () => {
    const invalidJson = vi.fn().mockImplementationOnce(() => completed(id)).mockImplementationOnce(() => completed("SECRET upstream error"))
      .mockImplementationOnce(() => completed());
    await expect(runAgentReachProcess("{}", image, new AbortController().signal, { spawn: invalidJson }))
      .rejects.toMatchObject({ message: "unknown_reader_error" });
    await expect(runAgentReachProcess("{}", image, new AbortController().signal, {
      spawn: () => { throw new Error("SECRET process error"); },
    })).rejects.toMatchObject({ message: "reader_not_configured" });
    const failedCreate = vi.fn().mockImplementationOnce(() => completed("SECRET error", 1))
      .mockImplementationOnce(() => completed());
    await expect(runAgentReachProcess("{}", image, new AbortController().signal, { spawn: failedCreate }))
      .rejects.toMatchObject({ message: "reader_not_configured" });
    expect(failedCreate.mock.calls.some(([args]) => (args as string[]).includes("start"))).toBe(false);
  });

  it("rejects oversized input before creating a container", async () => {
    const spawn = vi.fn();
    await expect(runAgentReachProcess("x".repeat(16 * 1024 + 1), image, new AbortController().signal, { spawn }))
      .rejects.toMatchObject({ code: "reader_not_configured" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 output instead of silently changing content", async () => {
    const reader = child();
    const spawn = vi.fn().mockImplementationOnce(() => completed(id)).mockReturnValueOnce(reader)
      .mockImplementationOnce(() => completed());
    const result = runAgentReachProcess("{}", image, new AbortController().signal, { spawn });
    const rejection = expect(result).rejects.toMatchObject({ code: "unknown_reader_error" });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    reader.stdout.write(Buffer.from([0x22, 0xff, 0x22])); reader.emit("close", 0);
    await rejection;
  });
});
