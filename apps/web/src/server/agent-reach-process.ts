import "server-only";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const RUNTIME_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
/** Fixed official local runtime paths; neither model input nor inherited Docker contexts select a daemon. */
export function agentReachDockerRuntime(platform: NodeJS.Platform = process.platform,
  homeDirectory = userInfo().homedir): { executable: string; host: string[] } {
  return platform === "darwin"
    ? { executable: "/Applications/Docker.app/Contents/Resources/bin/docker",
      host: ["--host", `unix://${join(homeDirectory, ".docker", "run", "docker.sock")}`] }
    : { executable: "docker", host: ["--host", "unix:///var/run/docker.sock"] };
}
const DOCKER_RUNTIME = agentReachDockerRuntime();
export const AGENT_REACH_IMAGE_PATTERN = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64})$/u;

export class AgentReachProcessError extends Error {
  constructor(readonly code: "reader_not_configured" | "network_timeout" | "unknown_reader_error",
    readonly cleanupUnconfirmed = false) {
    super(cleanupUnconfirmed ? "agent_reach_cleanup_unconfirmed" : code);
    this.name = "AgentReachProcessError";
  }
}

type Spawn = (args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const spawnDocker: Spawn = (args, env) => spawn(DOCKER_RUNTIME.executable, args, {
  env, shell: false, stdio: ["pipe", "pipe", "pipe"],
});
type CommandState = { launched: boolean; spawnFailed: boolean; completed: boolean };

/** Run only a fixed Docker operation. Diagnostics are drained, never retained. */
function dockerCommand(docker: Spawn, args: string[], env: NodeJS.ProcessEnv,
  options: { timeoutMs: number; maxBytes: number; input?: string; signal?: AbortSignal; state?: CommandState }):
  Promise<{ code: number | null; output: Buffer }> {
  options.signal?.throwIfAborted();
  if (options.timeoutMs <= 0) return Promise.reject(new AgentReachProcessError("network_timeout"));
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    let done = false, spawned = false, bytes = 0;
    let pendingError: Error | undefined;
    let termination: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, code: number | null = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (termination) clearTimeout(termination);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ code, output: Buffer.concat(chunks) });
    };
    const stop = (error: Error) => {
      if (done || pendingError) return;
      pendingError = error;
      // Wait for CLI termination before cleanup; daemon completion still needs
      // independent confirmation. A bounded fallback handles an unresponsive CLI.
      termination = setTimeout(() => finish(error), 1_000);
      try { child.kill("SIGKILL"); } catch { /* Cleanup still runs. */ }
    };
    const abort = () => stop(options.signal?.reason instanceof Error
      ? options.signal.reason : new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => stop(new AgentReachProcessError("network_timeout")), options.timeoutMs);
    try { child = docker([...DOCKER_RUNTIME.host, ...args], env); }
    catch { finish(new AgentReachProcessError("reader_not_configured")); return; }
    if (options.state) options.state.launched = true;
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => {
      if (options.state && !spawned) options.state.spawnFailed = true;
      finish(pendingError ?? new AgentReachProcessError("reader_not_configured"));
    });
    child.stdout.on("data", (data: Buffer) => {
      if (done || pendingError) return;
      bytes += data.length;
      if (bytes > options.maxBytes) { stop(new AgentReachProcessError("unknown_reader_error")); return; }
      chunks.push(data);
    });
    child.stderr.resume();
    child.stdin.on("error", () => stop(new AgentReachProcessError("unknown_reader_error")));
    child.once("close", code => {
      if (options.state) options.state.completed = !pendingError && typeof code === "number";
      finish(pendingError, code);
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else child.stdin.end(options.input);
  });
}

async function removeContainer(docker: Spawn, name: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<"removed" | "absent"> {
  const options = { timeoutMs, maxBytes: 4_096 };
  try {
    const removed = await dockerCommand(docker, ["rm", "--force", name], env, options);
    if (removed.code === 0) return "removed";
    // --rm may have removed an exited container already. A nonzero rm by itself
    // does NOT prove that. A name-filter query must return no matches; substring
    // matching is conservative and cannot omit our generated exact name.
    const listed = await dockerCommand(docker,
      ["container", "ls", "--all", "--filter", `name=${name}`, "--format", "{{.Names}}"], env, options);
    if (listed.code === 0 && listed.output.toString("utf8").trim() === "") return "absent";
  } catch { /* Never forward Docker diagnostics or mistake an outage for removal. */ }
  throw new AgentReachProcessError("unknown_reader_error", true);
}

/** One anonymous, disposable runtime per authorized read. No shell, mounts, registry pulls or inherited secrets. */
export async function runAgentReachProcess(input: string, image: string, signal: AbortSignal,
  dependencies: { spawn?: Spawn; timeoutMs?: number; cleanupTimeoutMs?: number } = {}): Promise<unknown> {
  signal.throwIfAborted();
  if (!AGENT_REACH_IMAGE_PATTERN.test(image) || Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new AgentReachProcessError("reader_not_configured");
  }
  const docker = dependencies.spawn ?? spawnDocker;
  const deadline = performance.now() + (dependencies.timeoutMs ?? 40_000);
  const directory = await mkdtemp(join(tmpdir(), "attention-agent-reach-"));
  const name = `attention-agent-reach-${randomUUID()}`;
  const env = { PATH: RUNTIME_PATH, HOME: directory, DOCKER_CONFIG: directory };
  const createState: CommandState = { launched: false, spawnFailed: false, completed: false };
  try {
    // In particular, cancellation while mkdtemp was pending must not dispatch IO.
    signal.throwIfAborted();
    const created = await dockerCommand(docker, ["create", "--rm", "--init", "-i", "--pull=never",
      "--name", name, "--network=bridge", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--user=65532:65532", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--pids-limit=64",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=16m", "--log-driver=none", "--stop-timeout=1", image], env,
    { timeoutMs: deadline - performance.now(), maxBytes: 4_096, signal, state: createState });
    if (created.code !== 0 || !/^[a-f0-9]{64}\s*$/u.test(created.output.toString("utf8"))) {
      throw new AgentReachProcessError("reader_not_configured");
    }
    signal.throwIfAborted();
    // create never executes upstream code. Only a confirmed create may start;
    // source JSON is supplied on this attached stdin, never in Docker arguments.
    const read = await dockerCommand(docker, ["start", "--attach", "--interactive", name], env,
      { timeoutMs: deadline - performance.now(), maxBytes: MAX_OUTPUT_BYTES, input, signal });
    if (read.code !== 0) throw new AgentReachProcessError("unknown_reader_error");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.output)) as unknown; }
    catch { throw new AgentReachProcessError("unknown_reader_error"); }
  } finally {
    try {
      if (createState.launched && !createState.spawnFailed) {
        const cleanup = await removeContainer(docker, name, env, dependencies.cleanupTimeoutMs ?? 5_000);
        if (!createState.completed && cleanup === "absent") {
          // An interrupted create request could finish later at the daemon. It
          // can leave only a stopped container, but absence is not yet conclusive.
          throw new AgentReachProcessError("unknown_reader_error", true);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
