import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
} from "@attention/contracts";

import type { CommandRunner } from "./command-runner";
import {
  applyConfigurePlan,
  buildConfigurePlan,
  defaultSkillDirectory,
  downloadAttentionSkillBundle,
  listAgentIntegrations,
  stageAttentionSkill,
} from "./configure";

const temporaryDirectories: string[] = [];

const validSkillDocument = readFileSync(
  new URL("../../web/public/skills/attention/SKILL.md", import.meta.url),
  "utf8",
);

function documentSha256(document: string): string {
  return createHash("sha256").update(document).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Agent configuration plans", () => {
  it("derives all five hosts from the contracts manifest", () => {
    expect(listAgentIntegrations().map((integration) => integration.id)).toEqual([
      "openclaw",
      "hermes",
      "codex",
      "claude-code",
      "workbuddy",
    ]);
    expect(
      listAgentIntegrations().every(
        (integration) => !integration.wechatIdentityObservable,
      ),
    ).toBe(true);
  });

  it("renders Codex MCP commands and the shipped bridge boundary", () => {
    const plan = buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
      skillDirectory: "/tmp/attention skill",
    });
    expect(plan.mcpAddCommand).toEqual({
      args: [
        "mcp",
        "add",
        "attention",
        "--url",
        "https://attention.example/mcp",
      ],
      executable: "codex",
    });
    expect(plan.skillDirectory).toBe("/tmp/attention skill");
    expect(plan.stageSkill).toBe(true);
    expect(plan.profile.inbound.engine).toBe("attention_channel_bridge");
    expect(plan.inboundBoundary).toMatch(/attention-channel bridge/u);
    expect(plan.inboundBoundary).toMatch(/attention channel start codex/u);
    expect(plan.channelCommands).toEqual([
      {
        args: [
          "channel",
          "start",
          "codex",
          "--origin",
          "https://attention.example",
          "--background",
        ],
        executable: "attention",
      },
    ]);
  });

  it("uses host-appropriate Skill install and staging locations", () => {
    expect(defaultSkillDirectory("codex")).toBe(
      join(homedir(), ".agents", "skills", "attention"),
    );
    expect(defaultSkillDirectory("claude-code")).toBe(
      join(homedir(), ".claude", "skills", "attention"),
    );
    expect(defaultSkillDirectory("openclaw")).toBe(
      join(process.cwd(), "attention-skill"),
    );
    expect(defaultSkillDirectory("workbuddy")).toBe(
      join(homedir(), "Downloads"),
    );
    expect(buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
    }).profile.skill.delivery).toBe("host_user_directory");
    expect(buildConfigurePlan({
      hostId: "claude-code",
      origin: "https://attention.example",
    }).profile.skill.delivery).toBe("host_user_directory");
  });

  it("publishes a verified WorkBuddy bundle while keeping import UI-managed", () => {
    const plan = buildConfigurePlan({
      hostId: "workbuddy",
      origin: "https://attention.example",
    });
    expect(plan.mcpAddCommand).toBeNull();
    expect(plan.loginCommand).toBeNull();
    expect(plan.mcpProbeCommand).toBeNull();
    expect(plan.channelCommands).toEqual([]);
    expect(plan.profile.skill.delivery).toBe("host_upload_bundle");
    expect(plan.downloadSkillBundle).toBe(true);
    expect(plan.skillBundleUrl).toBe(
      `https://attention.example${ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH}`,
    );
    expect(plan.skillBundleSha256).toBe(ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256);
    expect(plan.stageSkill).toBe(false);
    expect(plan.inboundBoundary).toMatch(/cannot observe|not the local WeChat/);
  });

  it("identifies Claude Code inbound as the shipped attention-channel bridge", () => {
    const plan = buildConfigurePlan({
      hostId: "claude-code",
      origin: "https://attention.example",
    });
    expect(plan.profile.inbound.availability).toBe("available");
    expect(plan.profile.inbound.engine).toBe("attention_channel_bridge");
    expect(plan.inboundBoundary).toMatch(/attention-channel bridge/u);
    expect(plan.inboundBoundary).toMatch(/attention channel start claude-code/u);
  });

  it("keeps Hermes discovery-first OAuth setup in the user's interactive terminal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const invocations: string[] = [];
    const plan = buildConfigurePlan({
      hostId: "hermes",
      origin: "https://attention.example",
      skillDirectory: directory,
    });
    const results = await applyConfigurePlan(plan, {
      fetchImpl: async () =>
        new Response(validSkillDocument, { status: 200 }),
      login: true,
      runner: async (invocation) => {
        invocations.push([invocation.executable, ...invocation.args].join("\0"));
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: "",
          timedOut: false,
        };
      },
    });

    expect(plan.profile.mcp.setup_mode).toBe("interactive_oauth");
    expect(invocations).toEqual([
      "hermes\0skills\0install\0--help",
      "hermes\0mcp\0add\0--help",
      "hermes\0mcp\0test\0--help",
      "hermes\0skills\0install\0https://attention.example/skills/attention/SKILL.md",
    ]);
    expect(results.find((result) => result.id === "configure_mcp")).toMatchObject({
      detail: expect.stringContaining("interactive terminal"),
      status: "manual",
    });
    expect(results.some((result) => result.id === "authorize_mcp")).toBe(false);
  });
});

describe("Skill staging and apply", () => {
  it("authorizes the dedicated Runtime client after Codex MCP login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const events: string[] = [];
    const plan = buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
      skillDirectory: directory,
    });

    const results = await applyConfigurePlan(plan, {
      authorizeRuntime: async ({ origin }) => {
        events.push(`runtime-oauth ${origin}`);
        return {
          access_token: "not-rendered",
          access_token_expires_at: "2026-08-10T11:00:00.000Z",
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
      fetchImpl: async () => {
        events.push("fetch-skill");
        return new Response(validSkillDocument, { status: 200 });
      },
      login: true,
      runner: async (invocation) => {
        events.push([invocation.executable, ...invocation.args].join(" "));
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: "ok",
          timedOut: false,
        };
      },
    });

    expect(events.at(-2)).toMatch(/mcp login|mcp auth/u);
    expect(events.at(-1)).toBe("runtime-oauth https://attention.example");
    expect(results.at(-1)).toMatchObject({
      id: "authorize_runtime",
      status: "applied",
    });
    expect(JSON.stringify(results)).not.toContain("not-rendered");
  });

  it("does not open Runtime OAuth without the explicit login flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const authorizeRuntime = vi.fn();
    const plan = buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
      skillDirectory: directory,
    });

    const results = await applyConfigurePlan(plan, {
      authorizeRuntime,
      fetchImpl: async () => new Response(validSkillDocument, { status: 200 }),
      login: false,
      runner: async () => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "ok",
        timedOut: false,
      }),
    });

    expect(authorizeRuntime).not.toHaveBeenCalled();
    expect(results.at(-1)).toMatchObject({
      id: "authorize_runtime",
      status: "manual",
    });
  });

  it("does not start Runtime OAuth after MCP login failure or expose OAuth secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const plan = buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
      skillDirectory: directory,
    });
    const authorizeRuntime = vi.fn(async () => {
      throw new Error("refresh_token=runtime-refresh-token-secret");
    });
    let failLogin = true;
    const runner: CommandRunner = async (invocation) => ({
      exitCode:
        failLogin && invocation.args.includes("login") ? 1 : 0,
      signal: null,
      stderr: failLogin && invocation.args.includes("login")
        ? "login failed"
        : "",
      stdout: "",
      timedOut: false,
    });

    const failedLogin = await applyConfigurePlan(plan, {
      authorizeRuntime,
      fetchImpl: async () => new Response(validSkillDocument, { status: 200 }),
      login: true,
      runner,
    });
    expect(failedLogin.at(-1)).toMatchObject({
      id: "authorize_mcp",
      status: "failed",
    });
    expect(authorizeRuntime).not.toHaveBeenCalled();

    failLogin = false;
    const failedRuntime = await applyConfigurePlan(plan, {
      authorizeRuntime,
      fetchImpl: async () => new Response(validSkillDocument, { status: 200 }),
      forceSkill: true,
      login: true,
      runner,
    });
    expect(failedRuntime.at(-1)).toMatchObject({
      id: "authorize_runtime",
      status: "failed",
    });
    expect(JSON.stringify(failedRuntime)).not.toContain(
      "runtime-refresh-token-secret",
    );
  });

  it("stages a bounded, validated SKILL.md atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const document = validSkillDocument;
    const target = await stageAttentionSkill({
      directory,
      fetchImpl: async () => new Response(document, { status: 200 }),
      sourceUrl: "https://attention.example/skills/attention/SKILL.md",
    });
    expect(await readFile(target, "utf8")).toBe(document);
    const changedDocument = `${document}\nchanged`;
    await expect(
      stageAttentionSkill({
        directory,
        expectedDocumentSha256: documentSha256(changedDocument),
        fetchImpl: async () => new Response(changedDocument, { status: 200 }),
        sourceUrl: "https://attention.example/skills/attention/SKILL.md",
      }),
    ).rejects.toThrow(/--force-skill/);
  });

  it.each([
    {
      document: validSkillDocument.replace(
        "Skill version: `1.4.0`",
        "Skill version: `1.2.0`",
      ),
      expectedError: /Skill version mismatch.*expected 1\.4\.0.*received 1\.2\.0/i,
      name: "Skill package version",
    },
    {
      document: validSkillDocument.replace(
        "Tool contract version: `1.3.0`",
        "Tool contract version: `1.2.0`",
      ),
      expectedError:
        /Tool contract version mismatch.*expected 1\.3\.0.*received 1\.2\.0/i,
      name: "tool contract version",
    },
  ])("rejects a downloaded SKILL.md with a stale $name", async ({
    document,
    expectedError,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);

    await expect(
      stageAttentionSkill({
        directory,
        expectedDocumentSha256: documentSha256(document),
        fetchImpl: async () => new Response(document, { status: 200 }),
        sourceUrl: "https://attention.example/skills/attention/SKILL.md",
      }),
    ).rejects.toThrow(expectedError);
    await expect(access(join(directory, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects content drift even when Skill and tool contract versions are unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const driftedDocument = `${validSkillDocument}\n<!-- same-version drift -->\n`;

    await expect(
      stageAttentionSkill({
        directory,
        fetchImpl: async () => new Response(driftedDocument, { status: 200 }),
        sourceUrl: "https://attention.example/skills/attention/SKILL.md",
      }),
    ).rejects.toThrow(/Skill document checksum mismatch/i);
    await expect(access(join(directory, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs every compatibility check before downloading or changing host configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const events: string[] = [];
    const plan = buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
      skillDirectory: directory,
    });

    const results = await applyConfigurePlan(plan, {
      fetchImpl: async () => {
        events.push("fetch-skill");
        return new Response(validSkillDocument, { status: 200 });
      },
      login: false,
      runner: async (invocation) => {
        events.push([invocation.executable, ...invocation.args].join(" "));
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: "ok",
          timedOut: false,
        };
      },
    });

    expect(events).toEqual([
      "codex mcp add --help",
      "codex mcp get --help",
      "fetch-skill",
      "codex mcp add attention --url https://attention.example/mcp",
    ]);
    expect(results.filter((result) => result.id.startsWith("compatibility_check_")))
      .toHaveLength(2);
  });

  it("leaves Skill and host configuration untouched when a compatibility check fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    let fetched = false;
    const invocations: string[] = [];
    const plan = buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
      skillDirectory: directory,
    });

    const results = await applyConfigurePlan(plan, {
      fetchImpl: async () => {
        fetched = true;
        return new Response(validSkillDocument, { status: 200 });
      },
      login: false,
      runner: async (invocation) => {
        invocations.push([invocation.executable, ...invocation.args].join(" "));
        return {
          exitCode: 2,
          signal: null,
          stderr: "unsupported command",
          stdout: "",
          timedOut: false,
        };
      },
    });

    expect(invocations).toEqual(["codex mcp add --help"]);
    expect(fetched).toBe(false);
    expect(results).toEqual([
      expect.objectContaining({
        id: "compatibility_check_1",
        status: "failed",
      }),
    ]);
    await expect(access(join(directory, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates Hermes' remote Skill contract before invoking the host installer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const invocations: string[] = [];
    const plan = buildConfigurePlan({
      hostId: "hermes",
      origin: "https://attention.example",
      skillDirectory: directory,
    });

    const results = await applyConfigurePlan(plan, {
      fetchImpl: async () =>
        new Response(
          validSkillDocument.replace(
            "Tool contract version: `1.3.0`",
            "Tool contract version: `1.0.0`",
          ),
          { status: 200 },
        ),
      login: false,
      runner: async (invocation) => {
        invocations.push([invocation.executable, ...invocation.args].join(" "));
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: "ok",
          timedOut: false,
        };
      },
    });

    expect(invocations).toEqual([
      "hermes skills install --help",
      "hermes mcp add --help",
      "hermes mcp test --help",
    ]);
    expect(results.at(-1)).toMatchObject({
      id: "validate_skill",
      status: "failed",
    });
  });

  it("downloads a checksum-pinned WorkBuddy bundle to a selected directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const bundle = await readFile(
      new URL(
        `../../web/public${ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH}`,
        import.meta.url,
      ),
    );
    const target = await downloadAttentionSkillBundle({
      directory,
      expectedSha256: ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
      fetchImpl: async () =>
        new Response(bundle, {
          headers: { "Content-Type": "application/zip" },
          status: 200,
        }),
      sourceUrl: `https://attention.example${ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH}`,
    });
    expect(target).toBe(
      join(directory, basename(ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH)),
    );
    expect(await readFile(target)).toEqual(bundle);
  });

  it("applies manifest commands with shell=false semantics and leaves OAuth explicit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const invocations: string[] = [];
    const runner: CommandRunner = async (invocation) => {
      invocations.push([invocation.executable, ...invocation.args].join("\0"));
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "ok",
        timedOut: false,
      };
    };
    const plan = buildConfigurePlan({
      hostId: "codex",
      origin: "https://attention.example",
      skillDirectory: directory,
    });
    const results = await applyConfigurePlan(plan, {
      fetchImpl: async () =>
        new Response(validSkillDocument, { status: 200 }),
      login: false,
      runner,
    });
    expect(invocations).toEqual([
      "codex\0mcp\0add\0--help",
      "codex\0mcp\0get\0--help",
      "codex\0mcp\0add\0attention\0--url\0https://attention.example/mcp",
    ]);
    expect(results.find((result) => result.id === "install_skill")).toMatchObject({
      detail: expect.stringContaining("Installed"),
      status: "applied",
    });
    expect(results.find((result) => result.id === "stage_skill")).toBeUndefined();
    expect(results.find((result) => result.id === "authorize_mcp")).toMatchObject({
      status: "manual",
    });
  });

  it("downloads WorkBuddy's bundle but leaves import and OAuth to its UI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attention-cli-"));
    temporaryDirectories.push(directory);
    const bundle = await readFile(
      new URL(
        `../../web/public${ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH}`,
        import.meta.url,
      ),
    );
    let fetched = false;
    const plan = buildConfigurePlan({
      hostId: "workbuddy",
      origin: "https://attention.example",
      skillDirectory: directory,
    });
    const results = await applyConfigurePlan(plan, {
      fetchImpl: async () => {
        fetched = true;
        return new Response(bundle, { status: 200 });
      },
      login: false,
      runner: async () => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "",
        timedOut: false,
      }),
    });
    expect(fetched).toBe(true);
    expect(results.find((result) => result.id === "download_skill_bundle")).toMatchObject({
      detail: expect.stringContaining("Downloaded and verified"),
      status: "applied",
    });
    expect(results.find((result) => result.id === "install_skill")).toMatchObject({
      detail: expect.stringContaining("Upload the downloaded ZIP"),
      status: "manual",
    });
    expect(results.find((result) => result.id === "configure_mcp")).toMatchObject({
      detail: expect.stringContaining("manual UI"),
      status: "manual",
    });
  });
});
