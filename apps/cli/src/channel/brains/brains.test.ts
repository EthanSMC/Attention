import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ATTENTION_MCP_TOOL_NAMES } from "@attention/contracts";

import type { BrainInvocation, ExecBrainResult } from "../brain";
import { createClaudeCodeBrain } from "./claude-code";
import {
  createCodexBrain,
  findLatestCodexSessionId,
  parseCodexJsonLines,
} from "./codex";

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
    });
    expect(captured.invocation?.environment).not.toHaveProperty("HOME");
    expect(captured.invocation?.environment).not.toHaveProperty("USERPROFILE");
    expect(captured.invocation?.args.slice(0, 7)).toEqual([
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
    ]);
    expect(captured.invocation?.args).toContain(
      'mcp_servers.attention.url="https://attention.example/mcp"',
    );
    expect(captured.invocation?.args).toContain(
      'mcp_servers.attention.enabled_tools=["attention_get_my_account","attention_list_collections","attention_collect_content","attention_select_collection_candidate","attention_get_collection_status","attention_update_collection"]',
    );
    expect(captured.invocation?.args).toContain("--json");
    expect(captured.invocation?.args).toContain('model="gpt-5.6-luna"');
    expect(captured.invocation?.args).toContain(
      'model_reasoning_effort="medium"',
    );
    expect(captured.invocation?.args).toContain('model_verbosity="low"');
    for (const tool of [
      "attention_collect_content",
      "attention_select_collection_candidate",
      "attention_update_collection",
    ]) {
      expect(captured.invocation?.args).toContain(
        `mcp_servers.attention.tools.${tool}.approval_mode="approve"`,
      );
    }
    expect(captured.invocation?.args).toContain("--ignore-rules");
    for (const feature of [
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
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
    expect(captured.invocation?.args).not.toContain("code_mode_host");
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

  it("uses the thread id and reply emitted by codex JSONL", async () => {
    const threadId = "019feb18-58cb-73d0-b579-e23e47b6eb53";
    const brain = createCodexBrain({
      execImpl: async () =>
        execResult({
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: threadId }),
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "已收藏 ✓" },
            }),
          ].join("\n"),
        }),
      homeDirectory: await makeTempDir("attention-codex-jsonl-"),
      mcpUrl: "https://attention.example/mcp",
    });

    const outcome = await brain.invoke({
      cwd: "/tmp",
      prompt: "收藏",
      sessionId: null,
    });

    expect(outcome).toMatchObject({
      ok: true,
      reply: "已收藏 ✓",
      sessionId: threadId,
    });
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

describe("parseCodexJsonLines", () => {
  it("ignores malformed events while retaining the latest Agent message", () => {
    expect(
      parseCodexJsonLines(
        [
          "not-json",
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "first" },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "final" },
          }),
        ].join("\n"),
      ),
    ).toEqual({ reply: "final", sessionId: "thread-1" });
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

  it("ignores an older session whose file was modified during the invocation", async () => {
    const home = await makeTempDir("attention-codex-session-race-");
    const oldDir = join(home, ".codex", "sessions", "2026", "07", "31");
    const newDir = join(home, ".codex", "sessions", "2026", "08", "10");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    const oldUuid = "019fb67d-6501-7943-98dc-5ea421741aa0";
    const newUuid = "019feb0c-2613-7932-9e7e-80efd6ad361a";
    const startedAt = new Date("2026-08-10T17:41:09").getTime();
    await writeFile(
      join(newDir, `rollout-2026-08-10T17-41-09-${newUuid}.jsonl`),
      "{}",
      "utf8",
    );
    await writeFile(
      join(oldDir, `rollout-2026-07-31T12-44-59-${oldUuid}.jsonl`),
      "{}",
      "utf8",
    );

    const found = await findLatestCodexSessionId({
      homeDirectory: home,
      sinceMs: startedAt,
    });
    expect(found).toBe(newUuid);
  });
});
