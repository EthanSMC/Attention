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
  it("reports the exact side-effect-free identity used to probe an update candidate", async () => {
    const capture = captureOutput();

    expect(
      await runAttentionCli(["--bridge-update-probe"], {
        output: capture.output,
      }),
    ).toBe(0);
    expect(capture.errors).toEqual([]);
    expect(capture.logs).toEqual([
      JSON.stringify({
        permission_profile_sha256:
          "2b2bca585577cd6f0d2adc310f798a8e200ac6a274862b3564c9b36408c1606d",
        version: "0.3.5",
      }),
    ]);
  });

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

  it("keeps Runtime OAuth out of configure and enables it explicitly", async () => {
    const capture = captureOutput();
    let configureOptions: unknown;
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
          configureOptions = options;
          return [];
        },
        output: capture.output,
      },
    )).toBe(0);
    expect(configureOptions).not.toHaveProperty("authorizeRuntime");

    const runtimeInputs: unknown[] = [];
    expect(await runAttentionCli(
      [
        "device",
        "sync",
        "enable",
        "--origin",
        "https://attention.example",
      ],
      {
        authorizeRuntime: async (input) => {
          runtimeInputs.push(input);
          return {
            access_token: "not-rendered",
            access_token_expires_at: "2026-08-12T12:00:00.000Z",
            audience: "attention-channel-runtime",
            authorization_server: "https://attention.example",
            client_id: "runtime-client",
            protected_resource_metadata_url:
              "https://attention.example/.well-known/oauth-protected-resource/api/runtime",
            refresh_token: "not-rendered",
            resource: "https://attention.example/api/runtime",
            scopes: [
              "runtime:register",
              "runtime:heartbeat",
              "channel:bind:report",
              "channel:disconnect:report",
            ],
            token_type: "Bearer",
            version: 1,
          };
        },
        loadRuntimeIdentity: async () => ({
          deviceName: "Studio Mac",
          installationId: "11111111-1111-4111-8111-111111111111",
        }),
        output: capture.output,
      },
    )).toBe(0);
    expect(runtimeInputs).toEqual([
      expect.objectContaining({
        deviceName: "Studio Mac",
        installationId: "11111111-1111-4111-8111-111111111111",
        origin: "https://attention.example",
      }),
    ]);
    expect(capture.logs.at(-1)).toContain("设备状态同步已启用");
    expect(capture.logs.join("\n")).not.toContain("not-rendered");
  });

  it("reports device sync failure without exposing OAuth material or invalidating MCP", async () => {
    const capture = captureOutput();
    expect(await runAttentionCli(
      [
        "device",
        "sync",
        "enable",
        "--origin",
        "https://attention.example",
      ],
      {
        authorizeRuntime: async () => {
          throw new Error("refresh_token=runtime-refresh-secret");
        },
        loadRuntimeIdentity: async () => ({
          deviceName: "Studio Mac",
          installationId: "11111111-1111-4111-8111-111111111111",
        }),
        output: capture.output,
      },
    )).toBe(2);
    const message = capture.errors.join("\n");
    expect(message).toContain("设备状态同步未启用");
    expect(message).toContain("MCP、微信和收藏不受影响");
    expect(message).not.toContain("runtime-refresh-secret");
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
