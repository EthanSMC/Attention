import { spawn } from "node:child_process";

import { boundedDiagnosticOutput } from "./redact";
import { resolveHostExecutable } from "./host-executable";

const MAXIMUM_CAPTURE_BYTES = 65_536;

export interface CommandInvocation {
  readonly args: readonly string[];
  readonly executable: string;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export type CommandRunner = (
  invocation: CommandInvocation,
  options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (
  invocation,
  options = {},
): Promise<CommandResult> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const executable = await resolveHostExecutable(invocation.executable);
  options.signal?.throwIfAborted();
  return await new Promise((resolve) => {
    const child = spawn(executable, [...invocation.args], {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = capture(stderr, chunk, stderrBytes);
    });
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
    });

    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (forceKillTimer) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    options.signal?.addEventListener("abort",terminate,{once:true});
    if (options.signal?.aborted) terminate();

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort",terminate);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        exitCode,
        signal,
        stderr: boundedDiagnosticOutput(Buffer.concat(stderr).toString("utf8")),
        stdout: boundedDiagnosticOutput(Buffer.concat(stdout).toString("utf8")),
        timedOut,
      });
    });
  });
};

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatInvocation(invocation: CommandInvocation): string {
  return [invocation.executable, ...invocation.args].map(shellQuote).join(" ");
}
