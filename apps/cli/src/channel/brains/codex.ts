/**
 * Codex CLI brain adapter.
 *
 * Invocation shape proven by the Python PoC on the orphan `wechat-adapter`
 * branch: `codex exec --skip-git-repo-check --sandbox read-only
 * --output-last-message <file> -- <prompt>`. The read-only sandbox blocks
 * filesystem writes; the bridge prompt forbids non-Attention tools.
 *
 * The argv shape, resume ordering, `--ignore-user-config`, feature disables,
 * and per-invocation `-c mcp_servers.attention.url=...` override were checked
 * against the bundled Codex CLI 0.147.0-alpha.6.5 on 2026-08-10. Session ids
 * are recovered from `~/.codex/sessions/**\/rollout-*.jsonl`
 * filenames, which encode `<timestamp>-<uuid>`; any failure to resume or to
 * locate the session degrades to transcript replay, never to a hard error.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  type BrainAdapter,
  type BrainInvokeInput,
  type BrainOutcome,
  execBrain,
} from "../brain";
import { BRAIN_TIMEOUT_MS } from "../limits";

const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-9;]*[A-Za-z]`,
  "gu",
);
const ROLLOUT_UUID_RE =
  /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;

export function codexSessionsDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".codex", "sessions");
}

/**
 * Finds the newest Codex session file created at or after `sinceMs` and
 * returns its session UUID. Best-effort: returns null when nothing matches.
 */
export async function findLatestCodexSessionId(input: {
  readonly homeDirectory?: string;
  readonly sinceMs: number;
}): Promise<string | null> {
  const root = codexSessionsDirectory(
    input.homeDirectory ?? homedir(),
  );
  const candidates: Array<{ mtimeMs: number; uuid: string }> = [];
  // Sessions are bucketed by YYYY/MM/DD; scan every bucket rather than
  // guessing today's date across midnight boundaries.
  try {
    for (const year of await readdir(root)) {
      const yearPath = join(root, year);
      let months: string[] = [];
      try {
        months = await readdir(yearPath);
      } catch {
        continue;
      }
      for (const month of months) {
        const monthPath = join(yearPath, month);
        let days: string[] = [];
        try {
          days = await readdir(monthPath);
        } catch {
          continue;
        }
        for (const day of days) {
          const dayPath = join(monthPath, day);
          let files: string[] = [];
          try {
            files = await readdir(dayPath);
          } catch {
            continue;
          }
          for (const file of files) {
            const match = ROLLOUT_UUID_RE.exec(file);
            const uuid = match?.[1];
            if (!uuid) continue;
            try {
              const info = await stat(join(dayPath, file));
              if (info.mtimeMs >= input.sinceMs) {
                candidates.push({ mtimeMs: info.mtimeMs, uuid });
              }
            } catch {
              // Ignore files that disappear while scanning.
            }
          }
        }
      }
    }
  } catch {
    return null;
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.uuid ?? null;
}

export interface CodexBrainOptions {
  readonly codexHomeDirectory?: string;
  readonly execImpl?: typeof execBrain;
  readonly homeDirectory?: string;
  readonly mcpUrl: string;
}

export function createCodexBrain(
  options: CodexBrainOptions,
): BrainAdapter {
  const execImpl = options.execImpl ?? execBrain;
  return {
    hostId: "codex",
    async invoke(input: BrainInvokeInput): Promise<BrainOutcome> {
      const startedAt = Date.now();
      const outFile = join(
        tmpdir(),
        `attention-codex-${randomUUID()}.txt`,
      );
      const baseArgs = [
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        ...[
          "apps",
          "browser_use",
          "browser_use_external",
          "browser_use_full_cdp_access",
          "code_mode_host",
          "computer_use",
          "image_generation",
          "in_app_browser",
          "hooks",
          "multi_agent",
          "multi_agent_v2",
          "plugin_sharing",
          "plugins",
          "remote_plugin",
          "shell_tool",
          "skill_mcp_dependency_install",
          "skill_search",
          "unified_exec",
          "workspace_dependencies",
        ].flatMap((feature) => ["--disable", feature]),
        "-c",
        `mcp_servers.attention.url=${JSON.stringify(options.mcpUrl)}`,
        "--output-last-message",
        outFile,
      ];
      // If a future host rejects resume, the bridge replays bounded history.
      const args = input.sessionId
        ? ["exec", ...baseArgs, "resume", input.sessionId, "--", input.prompt]
        : ["exec", ...baseArgs, "--", input.prompt];

      const result = await execImpl({
        args,
        cwd: input.cwd,
        environment: {
          CODEX_HOME:
            options.codexHomeDirectory ??
            (options.homeDirectory
              ? join(options.homeDirectory, ".codex")
              : process.env.CODEX_HOME ?? join(homedir(), ".codex")),
          HOME: input.cwd,
          USERPROFILE: input.cwd,
        },
        executable: "codex",
        timeoutMs: BRAIN_TIMEOUT_MS,
      });

      if (result.timedOut) {
        return {
          ok: false,
          reply: "",
          resumeFailed: false,
          sessionId: null,
          timedOut: true,
        };
      }

      let reply: string;
      try {
        reply = (await readFile(outFile, "utf8")).trim();
      } catch {
        reply = "";
      } finally {
        await rm(outFile, { force: true }).catch(() => undefined);
      }
      if (!reply) {
        reply = result.stdout.replace(ANSI_ESCAPE_RE, "").trim();
      }

      const sessionId =
        result.exitCode === 0
          ? await findLatestCodexSessionId({
              ...(options.homeDirectory
                ? { homeDirectory: options.homeDirectory }
                : {}),
              sinceMs: startedAt,
            })
          : null;

      const resumeFailed =
        Boolean(input.sessionId) &&
        (result.exitCode !== 0 ||
          /unknown command|unrecognized|no session|invalid session/iu.test(
            result.stderr,
          ));

      if (result.exitCode !== 0) {
        return {
          ok: false,
          reply: "",
          resumeFailed,
          sessionId: null,
          timedOut: false,
        };
      }
      return {
        ok: reply.length > 0,
        reply,
        resumeFailed: resumeFailed && reply.length === 0,
        sessionId,
        timedOut: false,
      };
    },
  };
}
