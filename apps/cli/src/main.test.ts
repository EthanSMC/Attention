import { describe, expect, it } from "vitest";

import { ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH } from "@attention/contracts";

import { runAttentionCli } from "./main";

function captureOutput(): {
  readonly errors: string[];
  readonly logs: string[];
  readonly output: { error: (value: string) => void; log: (value: string) => void };
} {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    output: {
      error: (value) => errors.push(value),
      log: (value) => logs.push(value),
    },
  };
}

describe("Attention CLI", () => {
  it("lists all integrations from the manifest", async () => {
    const capture = captureOutput();
    expect(
      await runAttentionCli(["integrations", "list"], {
        output: capture.output,
      }),
    ).toBe(0);
    expect(capture.logs.join("\n")).toMatch(/openclaw/);
    expect(capture.logs.join("\n")).toMatch(/workbuddy/);
    expect(capture.logs.join("\n")).toMatch(/cannot identify a real WeChat/);
  });

  it("prints a dry-run configuration and never starts OAuth", async () => {
    const capture = captureOutput();
    expect(
      await runAttentionCli(
        [
          "configure",
          "hermes",
          "--origin",
          "https://attention.example",
        ],
        { output: capture.output },
      ),
    ).toBe(0);
    const output = capture.logs.join("\n");
    expect(output).toContain(
      "hermes mcp add attention --url https://attention.example/mcp --auth oauth",
    );
    expect(output).toContain("Nothing was changed");
  });

  it("requires explicit apply before login", async () => {
    const capture = captureOutput();
    expect(
      await runAttentionCli(
        [
          "configure",
          "codex",
          "--origin",
          "https://attention.example",
          "--login",
        ],
        { output: capture.output },
      ),
    ).toBe(2);
    expect(capture.errors.join("\n")).toMatch(/--apply/);
  });

  it("passes the interactive Runtime authorizer only to configure apply", async () => {
    const capture = captureOutput();
    const authorizeRuntime = async () => {
      throw new Error("the apply dependency owns invocation order");
    };
    let receivedAuthorizer: unknown;
    expect(await runAttentionCli(
      [
        "configure",
        "codex",
        "--origin",
        "https://attention.example",
        "--apply",
        "--login",
      ],
      {
        applyConfigure: async (_plan, options) => {
          receivedAuthorizer = options.authorizeRuntime;
          return [];
        },
        authorizeRuntime,
        output: capture.output,
      },
    )).toBe(0);
    expect(receivedAuthorizer).toBe(authorizeRuntime);
  });

  it("shows WorkBuddy's downloadable bundle without claiming it was imported", async () => {
    const capture = captureOutput();
    expect(
      await runAttentionCli(
        [
          "configure",
          "workbuddy",
          "--origin",
          "https://attention.example",
        ],
        { output: capture.output },
      ),
    ).toBe(0);
    const output = capture.logs.join("\n");
    expect(output).toContain(ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH);
    expect(output).toContain("import in the host UI");
    expect(output).toContain("Nothing was changed");
    expect(output).not.toContain("Skill imported");
  });

  it("supports a machine-readable doctor without exposing tokens", async () => {
    const capture = captureOutput();
    const exitCode = await runAttentionCli(
      [
        "doctor",
        "codex",
        "--origin",
        "https://attention.example",
        "--json",
      ],
      {
        output: capture.output,
        runDoctorChecks: async () => [
          {
            detail: "Available; login was not executed.",
            id: "oauth_login",
            status: "pass",
            title: "OAuth login capability",
          },
        ],
      },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.logs[0] ?? "[]")).toEqual([
      expect.objectContaining({ id: "oauth_login", status: "pass" }),
    ]);
  });

  it("routes channel start to the bridge runner", async () => {
    const capture = captureOutput();
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = await runAttentionCli(
      [
        "channel",
        "start",
        "codex",
        "--origin",
        "https://attention.example",
      ],
      {
        output: capture.output,
        runChannel: async (input) => {
          calls.push({ ...input });
          return 0;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        action: "start",
        background: false,
        hostId: "codex",
        json: false,
        origin: "https://attention.example",
        service: false,
      },
    ]);
  });

  it("routes background channel activation without inventing a third navigation mode", async () => {
    const capture = captureOutput();
    const calls: Array<Record<string, unknown>> = [];
    expect(
      await runAttentionCli(
        [
          "channel",
          "start",
          "claude-code",
          "--origin",
          "https://attention.example",
          "--background",
        ],
        {
          authorizeRuntime: async () => {
            throw new Error("background channel start must never open OAuth");
          },
          output: capture.output,
          runChannel: async (input) => {
            calls.push({ ...input });
            return 0;
          },
        },
      ),
    ).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({
        action: "start",
        background: true,
        hostId: "claude-code",
        service: false,
      }),
    ]);
  });

  it("routes channel status and logout", async () => {
    const capture = captureOutput();
    const calls: Array<Record<string, unknown>> = [];
    const runChannel = async (input: {
      action: string;
      background: boolean;
      hostId: string | null;
      json: boolean;
      service: boolean;
    }) => {
      calls.push({ ...input });
      return 0;
    };
    expect(
      await runAttentionCli(["channel", "status", "--json"], {
        output: capture.output,
        runChannel,
      }),
    ).toBe(0);
    expect(
      await runAttentionCli(["channel", "logout"], {
        output: capture.output,
        runChannel,
      }),
    ).toBe(0);
    expect(calls).toEqual([
      {
        action: "status",
        background: false,
        hostId: null,
        json: true,
        service: false,
      },
      {
        action: "logout",
        background: false,
        hostId: null,
        json: false,
        service: false,
      },
    ]);
  });

  it("rejects malformed channel usage", async () => {
    const capture = captureOutput();
    const runChannel = async () => 0;
    expect(
      await runAttentionCli(["channel"], { output: capture.output, runChannel }),
    ).toBe(2);
    expect(
      await runAttentionCli(["channel", "start"], {
        output: capture.output,
        runChannel,
      }),
    ).toBe(2);
    expect(
      await runAttentionCli(["channel", "start", "codex", "--apply"], {
        output: capture.output,
        runChannel,
      }),
    ).toBe(2);
    expect(capture.errors.join("\n")).toMatch(
      /attention channel <start|does not accept --apply/u,
    );
  });

  it("documents the channel bridge in help", async () => {
    const capture = captureOutput();
    expect(await runAttentionCli(["--help"], { output: capture.output })).toBe(0);
    const help = capture.logs.join("\n");
    expect(help).toContain("attention channel start <codex|claude-code>");
    expect(help).toContain("separate Runtime OAuth");
    expect(help).toContain("never opens a browser");
    expect(help).not.toContain("does not ship an Attention iLink companion");
  });
});
