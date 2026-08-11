import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

const MAXIMUM_PROTOCOL_LINE_BYTES = 262_144;
const MAXIMUM_STDERR_BYTES = 262_144;

export interface ClaudeStreamMessage {
  readonly [key: string]: unknown;
}

export interface ClaudeStreamSnapshot {
  readonly exitCode: number | null;
  readonly lastErrorCode: ClaudeStreamRpcErrorCode | null;
  readonly phase: "idle" | "running" | "stopped";
  readonly pid: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export type ClaudeSpawnImplementation = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export interface ClaudeStreamRpcOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
  readonly spawnImpl?: ClaudeSpawnImplementation;
}

export type ClaudeStreamRpcErrorCode =
  | "not_running"
  | "process_exited"
  | "protocol_error"
  | "write_failed";

export class ClaudeStreamRpcError extends Error {
  constructor(
    readonly code: ClaudeStreamRpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeStreamRpcError";
  }
}

export class ClaudeStreamRpc {
  readonly #listeners = new Set<(message: ClaudeStreamMessage) => void>();
  readonly #options: ClaudeStreamRpcOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closeRequested = false;
  #exitCode: number | null = null;
  #exitPromise: Promise<ClaudeStreamSnapshot> | null = null;
  #lastErrorCode: ClaudeStreamRpcErrorCode | null = null;
  #phase: ClaudeStreamSnapshot["phase"] = "idle";
  #resolveExit: ((snapshot: ClaudeStreamSnapshot) => void) | null = null;
  #signal: NodeJS.Signals | null = null;
  #stderr = "";
  #stdoutBuffer = "";

  constructor(options: ClaudeStreamRpcOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#phase === "running") return;
    const spawnImpl = this.#options.spawnImpl ?? spawn;
    this.#closeRequested = false;
    this.#exitCode = null;
    this.#lastErrorCode = null;
    this.#signal = null;
    this.#stderr = "";
    this.#stdoutBuffer = "";
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    const child = spawnImpl(
      this.#options.executable ?? "claude",
      [...this.#options.args],
      {
        ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
        env: {
          ...process.env,
          ...this.#options.environment,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"] as const,
      },
    );
    this.#child = child;
    this.#phase = "running";

    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#consumeStderr(chunk));
    child.stdin.on("error", (error) => {
      if (this.#phase !== "running" || this.#closeRequested) return;
      this.#lastErrorCode = "write_failed";
      this.#failProtocol(error.message);
    });
    child.once("error", (error) => {
      if (this.#phase !== "running") return;
      this.#lastErrorCode = "process_exited";
      this.#handleClose(null, null, error.message);
    });
    child.once("close", (exitCode, signal) => {
      this.#handleClose(exitCode, signal);
    });
  }

  onMessage(listener: (message: ClaudeStreamMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(message: ClaudeStreamMessage): void {
    const child = this.#child;
    if (!child || this.#phase !== "running") {
      throw new ClaudeStreamRpcError(
        "not_running",
        "Claude stream-json process is not running",
      );
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.#lastErrorCode = "write_failed";
      throw new ClaudeStreamRpcError("write_failed", messageText);
    }
  }

  snapshot(): ClaudeStreamSnapshot {
    return {
      exitCode: this.#exitCode,
      lastErrorCode: this.#lastErrorCode,
      phase: this.#phase,
      pid: this.#child?.pid ?? null,
      signal: this.#signal,
      stderr: this.#stderr,
    };
  }

  async waitForExit(): Promise<ClaudeStreamSnapshot> {
    return this.#phase === "stopped" || !this.#exitPromise
      ? this.snapshot()
      : await this.#exitPromise;
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child || this.#phase !== "running") return;
    this.#closeRequested = true;
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("close", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#phase !== "running") return;
    this.#stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        if (
          Buffer.byteLength(this.#stdoutBuffer, "utf8") >
          MAXIMUM_PROTOCOL_LINE_BYTES
        ) {
          this.#failProtocol("Claude emitted an oversized stream-json line");
        }
        return;
      }
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) {
        this.#failProtocol("Claude emitted an oversized stream-json line");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.#failProtocol("Claude emitted malformed stream-json output");
        return;
      }
      if (parsed === null || typeof parsed !== "object") {
        this.#failProtocol("Claude emitted a non-object stream-json message");
        return;
      }
      for (const listener of this.#listeners) {
        listener(parsed as ClaudeStreamMessage);
      }
      if (this.#phase !== "running") return;
    }
  }

  #consumeStderr(chunk: Buffer): void {
    const capturedBytes = Buffer.byteLength(this.#stderr, "utf8");
    if (capturedBytes >= MAXIMUM_STDERR_BYTES) return;
    this.#stderr += chunk
      .subarray(0, MAXIMUM_STDERR_BYTES - capturedBytes)
      .toString("utf8");
  }

  #failProtocol(message: string): void {
    if (this.#phase !== "running") return;
    this.#lastErrorCode = "protocol_error";
    this.#child?.kill("SIGTERM");
    if (!this.#child) this.#handleClose(null, null, message);
  }

  #handleClose(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    _message?: string,
  ): void {
    if (this.#phase === "stopped" && this.#child === null) return;
    this.#exitCode = exitCode;
    this.#signal = signal;
    if (!this.#closeRequested && !this.#lastErrorCode) {
      this.#lastErrorCode = "process_exited";
    }
    this.#phase = "stopped";
    this.#child = null;
    const resolveExit = this.#resolveExit;
    this.#resolveExit = null;
    resolveExit?.(this.snapshot());
  }
}
