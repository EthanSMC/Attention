/**
 * Claude Code brain adapter (spike-verified on Claude Code 2.1.226):
 *
 * - `claude -p --output-format json` prints one JSON result object with
 *   `result`, `session_id`, and `is_error`; the prompt is piped via stdin
 *   because variadic flags (`--allowedTools`, `--tools`) would otherwise
 *   swallow a positional prompt.
 * - `--tools ""` removes every built-in tool; the MCP allowlist below is the
 *   only capability left, matching the restricted profile template.
 * - `--resume <session-id>` continues a previous headless session from any
 *   working directory, keeping tool-call context across turns. A failed
 *   resume (expired/unknown session) surfaces as `is_error` or a non-zero
 *   exit; the bridge then falls back to replaying the stored transcript.
 */

import {
  type BrainAdapter,
  type BrainInvokeInput,
  type BrainOutcome,
  execBrain,
} from "../brain";
import { BRAIN_TIMEOUT_MS } from "../limits";

import { ATTENTION_MCP_TOOL_NAMES } from "@attention/contracts";

const CLAUDE_ALLOWED_TOOLS = ATTENTION_MCP_TOOL_NAMES.map(
  (name) => `mcp__attention__${name}`,
);

interface ClaudeJsonResult {
  readonly is_error?: boolean;
  readonly result?: string;
  readonly session_id?: string;
}

function parseClaudeJson(stdout: string): ClaudeJsonResult | null {
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as ClaudeJsonResult;
    } catch {
      // Keep scanning upward for an earlier JSON payload.
    }
  }
  return null;
}

export interface ClaudeCodeBrainOptions {
  readonly execImpl?: typeof execBrain;
  readonly mcpUrl: string;
}

export function createClaudeCodeBrain(
  options: ClaudeCodeBrainOptions,
): BrainAdapter {
  const execImpl = options.execImpl ?? execBrain;
  return {
    hostId: "claude-code",
    async invoke(input: BrainInvokeInput): Promise<BrainOutcome> {
      const args = [
        "-p",
        "--safe-mode",
        "--output-format",
        "json",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            attention: { type: "http", url: options.mcpUrl },
          },
        }),
        "--tools",
        "",
        "--allowedTools",
        ...CLAUDE_ALLOWED_TOOLS,
      ];
      if (input.sessionId) {
        args.push("--resume", input.sessionId);
      }
      const result = await execImpl({
        args,
        cwd: input.cwd,
        executable: "claude",
        stdin: input.prompt,
        timeoutMs: BRAIN_TIMEOUT_MS,
      });

      const parsed = parseClaudeJson(result.stdout);
      const reply = (parsed?.result ?? "").trim();
      const sessionId =
        typeof parsed?.session_id === "string" && parsed.session_id
          ? parsed.session_id
          : null;

      if (result.timedOut) {
        return {
          ok: false,
          reply: "",
          resumeFailed: false,
          sessionId,
          timedOut: true,
        };
      }

      if (parsed && reply && !parsed.is_error) {
        return {
          ok: true,
          reply,
          resumeFailed: false,
          sessionId,
          timedOut: false,
        };
      }

      // A failed resume is recoverable by replaying history; any other
      // failure is reported to the user as-is.
      const resumeFailed =
        Boolean(input.sessionId) &&
        (result.exitCode !== 0 ||
          Boolean(parsed?.is_error) ||
          /no conversation found|could not resume|session.*not found/iu.test(
            result.stderr,
          ));
      const usable =
        reply.length > 0 && result.exitCode === 0 && !parsed?.is_error;
      return {
        ok: usable,
        reply: usable ? reply : "",
        resumeFailed,
        sessionId,
        timedOut: false,
      };
    },
  };
}
