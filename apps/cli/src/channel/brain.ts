/**
 * Brain abstraction: the bridge invokes the user's own local Agent as a
 * restricted subprocess. Two adapters ship in this release (Codex CLI and
 * Claude Code); both must honor the restricted profile semantics from
 * `installations/v1/templates/restricted-profile.json`: only the Attention
 * MCP plus the minimum conditional public-web reader, no shell/code
 * execution/filesystem write, no inherited session or working directory.
 */

import { spawn } from "node:child_process";

import { resolveHostExecutable } from "../host-executable";
import { boundedDiagnosticOutput } from "../redact";
import { createClaudeCodeBrain } from "./brains/claude-code";
import { createCodexBrain } from "./brains/codex";
import { BRAIN_TIMEOUT_MS } from "./limits";
import type { CollectionReplyControl } from "./collection-reply-control";
import type {
  AttentionMcpFailure,
  AttentionMcpProbeResult,
} from "./mcp-readiness";

const MAXIMUM_CAPTURE_BYTES = 262_144;

export interface BrainInvocation {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly stdin?: string;
  readonly timeoutMs: number;
}

export interface ExecBrainResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface BrainOutcome {
  /** Stable failure evidence from any Attention MCP tool call. */
  readonly attentionMcpFailure?: AttentionMcpFailure;
  /** Structured evidence emitted only for attention_get_my_account. */
  readonly attentionMcpProbe?: AttentionMcpProbeResult;
  /** Whether the invocation produced a usable reply. */
  readonly ok: boolean;
  /** Final user-facing text (empty when not ok). */
  readonly reply: string;
  /** Host session identifier reported by the host, when available. */
  readonly sessionId: string | null;
  /** True when a resume attempt failed and the caller should replay history. */
  readonly resumeFailed: boolean;
  readonly timedOut: boolean;
  /** Content-free control derived from Attention MCP results, when established. */
  readonly collectionReplyControl?: CollectionReplyControl;
}

export interface BrainInvokeInput {
  readonly cwd: string;
  readonly prompt: string;
  /** Existing host session to continue, when the host supports resume. */
  readonly sessionId: string | null;
}

export interface BrainRuntimeSnapshot {
  readonly phase:
    | "starting"
    | "healthy"
    | "restarting"
    | "recovering_thread"
    | "replaying_history"
    | "degraded_auth"
    | "degraded_runtime"
    | "stopped";
  readonly lastErrorCode: string | null;
  readonly retryAttempt: number;
}

export interface BrainAdapter {
  readonly hostId: "codex" | "claude-code";
  start(): Promise<void>;
  invoke(input: BrainInvokeInput): Promise<BrainOutcome>;
  shutdown(): Promise<void>;
  runtimeSnapshot(): BrainRuntimeSnapshot;
}

/**
 * Spawns a brain subprocess with optional stdin, bounded capture, and a hard
 * timeout. Mirrors `runCommand` in `command-runner.ts`, but the bridge needs
 * stdin for headless prompts and a larger capture window for JSON output.
 */
export async function execBrain(
  invocation: BrainInvocation,
): Promise<ExecBrainResult> {
  const executable = await resolveHostExecutable(invocation.executable);
  return await new Promise((resolve) => {
    const child = spawn(executable, [...invocation.args], {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...invocation.environment,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const capture = (
      chunks: Buffer[],
      chunk: Buffer,
      capturedBytes: number,
    ): number => {
      const remaining = MAXIMUM_CAPTURE_BYTES - capturedBytes;
      if (remaining <= 0) return capturedBytes;
      const bounded = chunk.subarray(0, remaining);
      chunks.push(bounded);
      return capturedBytes + bounded.byteLength;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = capture(stderr, chunk, stderrBytes);
    });
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
    });

    if (child.stdin) {
      child.stdin.on("error", () => {
        // The brain may exit before consuming all input; EPIPE is not fatal.
      });
      child.stdin.end(invocation.stdin ?? "", "utf8");
    }

    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, invocation.timeoutMs);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        exitCode,
        stderr: boundedDiagnosticOutput(
          Buffer.concat(stderr).toString("utf8"),
        ),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut:
          timedOut || (signal !== null && exitCode === null && timedOut),
      });
    });
  });
}

export function createBrainAdapter(
  hostId: "codex" | "claude-code",
  options: {
    readonly codexHomeDirectory?: string;
    readonly mcpUrl: string;
    readonly runtimeDirectory?: string;
  },
): BrainAdapter {
  return hostId === "claude-code"
    ? createClaudeCodeBrain({
        mcpUrl: options.mcpUrl,
        ...(options.runtimeDirectory
          ? { runtimeDirectory: options.runtimeDirectory }
          : {}),
      })
    : createCodexBrain({
        ...(options.codexHomeDirectory
          ? { codexHomeDirectory: options.codexHomeDirectory }
          : {}),
        mcpUrl: options.mcpUrl,
      });
}

export const BRAIN_DEFAULT_TIMEOUT_MS = BRAIN_TIMEOUT_MS;
