import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

const MAXIMUM_PROTOCOL_LINE_BYTES = 262_144;
const MAXIMUM_STDERR_BYTES = 262_144;

type JsonRpcId = number | string;

export interface CodexRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexRpcSnapshot {
  readonly exitCode: number | null;
  readonly phase: "idle" | "running" | "stopped";
  readonly pid: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export type CodexSpawnImplementation = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export interface CodexAppServerRpcOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
  readonly requestTimeoutMs?: number;
  readonly spawnImpl?: CodexSpawnImplementation;
}

export type CodexAppServerRpcErrorCode =
  | "not_running"
  | "process_exited"
  | "protocol_error"
  | "request_failed"
  | "request_timeout"
  | "write_failed";

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly code: CodexAppServerRpcErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

interface PendingRequest {
  readonly reject: (error: CodexAppServerRpcError) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  readonly error?: unknown;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

export class CodexAppServerRpc {
  readonly #options: CodexAppServerRpcOptions;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #notificationListeners = new Set<
    (event: CodexRpcNotification) => void
  >();
  #child: ChildProcessWithoutNullStreams | null = null;
  #exitCode: number | null = null;
  #nextRequestId = 1;
  #phase: CodexRpcSnapshot["phase"] = "idle";
  #signal: NodeJS.Signals | null = null;
  #stderr = "";
  #stdoutBuffer = "";

  constructor(options: CodexAppServerRpcOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#phase === "running") return;
    const spawnImpl = this.#options.spawnImpl ?? spawn;
    this.#exitCode = null;
    this.#signal = null;
    this.#stderr = "";
    this.#stdoutBuffer = "";
    const child = spawnImpl(
      this.#options.executable ?? "codex",
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
      if (this.#phase === "running") {
        this.#failProtocol(
          new CodexAppServerRpcError("write_failed", error.message),
        );
      }
    });
    child.once("error", (error) => {
      this.#handleClose(
        null,
        null,
        new CodexAppServerRpcError("process_exited", error.message),
      );
    });
    child.once("close", (exitCode, signal) => {
      this.#handleClose(exitCode, signal);
    });
  }

  onNotification(
    listener: (event: CodexRpcNotification) => void,
  ): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  request<T>(
    method: string,
    params: unknown,
    timeoutMs: number = this.#options.requestTimeoutMs ?? 30_000,
  ): Promise<T> {
    if (!this.#child || this.#phase !== "running") {
      return Promise.reject(
        new CodexAppServerRpcError(
          "not_running",
          "Codex app-server is not running",
        ),
      );
    }
    const id = this.#nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CodexAppServerRpcError(
            "request_timeout",
            `Codex app-server request timed out: ${method}`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
        timer,
      });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          error instanceof CodexAppServerRpcError
            ? error
            : new CodexAppServerRpcError(
                "write_failed",
                error instanceof Error ? error.message : String(error),
              ),
        );
      }
    });
  }

  snapshot(): CodexRpcSnapshot {
    return {
      exitCode: this.#exitCode,
      phase: this.#phase,
      pid: this.#child?.pid ?? null,
      signal: this.#signal,
      stderr: this.#stderr,
    };
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child || this.#phase !== "running") return;
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      const finished = () => {
        clearTimeout(forceTimer);
        resolve();
      };
      child.once("close", finished);
      child.kill("SIGTERM");
    });
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#phase !== "running") return;
    this.#stdoutBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) {
      this.#failProtocol(
        new CodexAppServerRpcError(
          "protocol_error",
          "Codex app-server protocol line exceeded the size limit",
        ),
      );
      return;
    }
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.#failProtocol(
          new CodexAppServerRpcError(
            "protocol_error",
            "Codex app-server emitted malformed JSON",
          ),
        );
        return;
      }
      if (message === null || typeof message !== "object") {
        this.#failProtocol(
          new CodexAppServerRpcError(
            "protocol_error",
            "Codex app-server emitted a non-object message",
          ),
        );
        return;
      }
      this.#handleMessage(message as JsonRpcMessage);
      if (this.#phase !== "running") return;
    }
  }

  #consumeStderr(chunk: Buffer): void {
    if (Buffer.byteLength(this.#stderr, "utf8") >= MAXIMUM_STDERR_BYTES) return;
    const remaining = MAXIMUM_STDERR_BYTES - Buffer.byteLength(this.#stderr, "utf8");
    this.#stderr += chunk.subarray(0, remaining).toString("utf8");
  }

  #handleMessage(message: JsonRpcMessage): void {
    if (message.method) {
      if (message.id !== undefined) {
        this.#handleServerRequest(message.id, message.method);
        return;
      }
      const notification = {
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      };
      for (const listener of this.#notificationListeners) {
        listener(notification);
      }
      return;
    }
    if (message.id === undefined) {
      this.#failProtocol(
        new CodexAppServerRpcError(
          "protocol_error",
          "Codex app-server response is missing an id",
        ),
      );
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(
        new CodexAppServerRpcError(
          "request_failed",
          "Codex app-server rejected a request",
          message.error,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #handleServerRequest(id: JsonRpcId, method: string): void {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval" ||
      method === "execCommandApproval"
    ) {
      this.#write({ id, result: { decision: "decline" } });
      return;
    }
    this.#write({
      error: { code: -32601, message: "Method not supported" },
      id,
    });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (!child || this.#phase !== "running") {
      throw new CodexAppServerRpcError(
        "not_running",
        "Codex app-server is not running",
      );
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  #failProtocol(error: CodexAppServerRpcError): void {
    this.#rejectPending(error);
    this.#child?.kill("SIGTERM");
  }

  #handleClose(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error = new CodexAppServerRpcError(
      "process_exited",
      `Codex app-server exited${exitCode === null ? "" : ` with code ${exitCode}`}`,
    ),
  ): void {
    if (this.#phase === "stopped" && this.#child === null) return;
    this.#exitCode = exitCode;
    this.#signal = signal;
    this.#phase = "stopped";
    this.#child = null;
    this.#rejectPending(error);
  }

  #rejectPending(error: CodexAppServerRpcError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
