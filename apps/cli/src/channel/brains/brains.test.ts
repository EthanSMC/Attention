import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ATTENTION_MCP_TOOL_NAMES } from "@attention/contracts";

import type { BrainInvocation, ExecBrainResult } from "../brain";
import { createClaudeCodeBrain } from "./claude-code";
import { createCodexBrain, findLatestCodexSessionId } from "./codex";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const execResult = (
  partial: Partial<ExecBrainResult>,
): ExecBrainResult => ({
  exitCode: 0,

  stderr: "",
  stdout: "",
  timedOut: false,
  ...partial,
});

describe("claude-code brain", () => {
  it("builds a restricted headless invocation with the prompt on stdin", async () => {
    const captured: { invocation: BrainInvocation | null } = { invocation: null };
    const brain = createClaudeCodeBrain({
      execImpl: async (input) => {
        captured.invocation = input;
        return execResult({
          stdout: JSON.stringify({
            is_error: false,
            result: "已收藏 ✓",
            session_id: "s-1",
          }),
        });
      },
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "收藏这个链接",
      sessionId: null,
    });
    expect(captured.invocation?.executable).toBe("claude");
    expect(captured.invocation?.args).toEqual([
      "-p",
      "--safe-mode",
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          attention: {
            type: "http",
            url: "https://attention.example/mcp",
          },
        },
      }),
      "--tools",
      "",
      "--allowedTools",
      ...ATTENTION_MCP_TOOL_NAMES.map((name) => `mcp__attention__${name}`),
    ]);
    expect(captured.invocation?.stdin).toBe("收藏这个链接");
    expect(outcome).toMatchObject({
      ok: true,
      reply: "已收藏 ✓",
      sessionId: "s-1",
    });
  });

  it("passes --resume when a session exists", async () => {
    const captured: { invocation: BrainInvocation | null } = { invocation: null };
    const brain = createClaudeCodeBrain({
      execImpl: async (input) => {
        captured.invocation = input;
        return execResult({
          stdout: JSON.stringify({ result: "ok", session_id: "s-1" }),
        });
      },
      mcpUrl: "https://attention.example/mcp",
    });
    await brain.invoke({ cwd: "/tmp", prompt: "选 1", sessionId: "s-1" });
    expect(captured.invocation?.args.slice(-2)).toEqual(["--resume", "s-1"]);
  });

  it("flags a failed resume so the pipeline can replay history", async () => {
    const brain = createClaudeCodeBrain({
      execImpl: async () =>
        execResult({
          exitCode: 1,
          stderr: "No conversation found with session ID: stale",
          stdout: "",
        }),
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "hello",
      sessionId: "stale",
    });
    expect(outcome.resumeFailed).toBe(true);
    expect(outcome.ok).toBe(false);
  });

  it("treats is_error results with text as failure but keeps the session", async () => {
    const brain = createClaudeCodeBrain({
      execImpl: async () =>
        execResult({
          stdout: JSON.stringify({
            is_error: true,
            result: "MCP unavailable",
            session_id: "s-2",
          }),
        }),
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "hi",
      sessionId: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.sessionId).toBe("s-2");
  });

  it("survives non-JSON output", async () => {
    const brain = createClaudeCodeBrain({
      execImpl: async () => execResult({ stdout: "something exploded" }),
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "hi",
      sessionId: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.resumeFailed).toBe(false);
  });

  it("reports timeouts", async () => {
    const brain = createClaudeCodeBrain({
      execImpl: async () => execResult({ timedOut: true }),
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "hi",
      sessionId: null,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.ok).toBe(false);
  });
});

describe("codex brain", () => {
  it("builds a sandboxed exec invocation and reads the last-message file", async () => {
    const captured: { invocation: BrainInvocation | null } = { invocation: null };
    const brain = createCodexBrain({
      execImpl: async (input) => {
        captured.invocation = input;
        const outIndex = input.args.indexOf("--output-last-message");
        const outFile = input.args[outIndex + 1];
        await writeFile(outFile ?? "", "已收藏 ✓", "utf8");
        return execResult({});
      },
      homeDirectory: await makeTempDir("attention-codex-home-"),
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "收藏",
      sessionId: null,
    });
    expect(captured.invocation?.executable).toBe("codex");
    expect(captured.invocation?.environment).toMatchObject({
      CODEX_HOME: expect.stringContaining("attention-codex-home-"),
      HOME: "/tmp",
      USERPROFILE: "/tmp",
    });
    expect(captured.invocation?.args.slice(0, 6)).toEqual([
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
    ]);
    expect(captured.invocation?.args).toContain(
      'mcp_servers.attention.url="https://attention.example/mcp"',
    );
    expect(captured.invocation?.args).toContain("--ignore-rules");
    for (const feature of [
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
    ]) {
      const flagIndex = captured.invocation?.args.indexOf("--disable") ?? -1;
      expect(captured.invocation?.args).toContain(feature);
      expect(flagIndex).toBeGreaterThan(-1);
    }
    expect(captured.invocation?.args.slice(-2)).toEqual(["--", "收藏"]);
    expect(outcome.ok).toBe(true);
    expect(outcome.reply).toBe("已收藏 ✓");
  });

  it("uses exec resume when a session id is stored", async () => {
    const captured: { invocation: BrainInvocation | null } = { invocation: null };
    const brain = createCodexBrain({
      execImpl: async (input) => {
        captured.invocation = input;
        return execResult({ stdout: "ok" });
      },
      homeDirectory: await makeTempDir("attention-codex-home-"),
      mcpUrl: "https://attention.example/mcp",
    });
    await brain.invoke({ cwd: "/tmp", prompt: "hi", sessionId: "uuid-1" });
    const args = captured.invocation?.args ?? [];
    expect(args.slice(0, 2)).toEqual(["exec", "--ignore-user-config"]);
    expect(args.indexOf("--sandbox")).toBeLessThan(args.indexOf("resume"));
    expect(args.indexOf("--output-last-message")).toBeLessThan(
      args.indexOf("resume"),
    );
    expect(args.slice(args.indexOf("resume"), args.indexOf("resume") + 2)).toEqual([
      "resume",
      "uuid-1",
    ]);
  });

  it("falls back to stdout when the last-message file is missing", async () => {
    const brain = createCodexBrain({
      execImpl: async () =>
        execResult({ stdout: "\u001b[32m来自 stdout\u001b[0m" }),
      homeDirectory: await makeTempDir("attention-codex-home-"),
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "hi",
      sessionId: null,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.reply).toBe("来自 stdout");
  });

  it("marks failed runs as not ok and keeps resume diagnostics", async () => {
    const brain = createCodexBrain({
      execImpl: async () =>
        execResult({ exitCode: 2, stderr: "unknown command: resume" }),
      homeDirectory: await makeTempDir("attention-codex-home-"),
      mcpUrl: "https://attention.example/mcp",
    });
    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "hi",
      sessionId: "uuid-9",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.resumeFailed).toBe(true);
  });
});

describe("findLatestCodexSessionId", () => {
  it("returns the newest rollout uuid created after the marker", async () => {
    const home = await makeTempDir("attention-codex-sessions-");
    const dayDir = join(home, ".codex", "sessions", "2026", "08", "08");
    await mkdir(dayDir, { recursive: true });
    const uuid = "019fd09e-c9e1-76a2-b181-de8b008340ae";
    await writeFile(
      join(dayDir, `rollout-2026-08-08T14-31-35-${uuid}.jsonl`),
      "{}",
      "utf8",
    );
    const found = await findLatestCodexSessionId({
      homeDirectory: home,
      sinceMs: 0,
    });
    expect(found).toBe(uuid);
  });

  it("returns null when no session exists", async () => {
    const home = await makeTempDir("attention-codex-empty-");
    const found = await findLatestCodexSessionId({
      homeDirectory: home,
      sinceMs: 0,
    });
    expect(found).toBeNull();
  });
});
