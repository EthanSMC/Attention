import {
  AGENT_INTEGRATION_IDS,
  ATTENTION_SKILL_DOCUMENT_SHA256,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH,
  ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
} from "@attention/contracts";
import { describe, expect, it } from "vitest";

import { projectAgentConnections } from "./agent-connection-projection";

describe("Agent connection public projection", () => {
  const connections = projectAgentConnections({
    mcpUrl: "https://attention.example/mcp",
    origin: "https://attention.example/",
  });

  it("projects every supported local Agent exactly once", () => {
    expect(connections.map((connection) => connection.id)).toEqual(
      AGENT_INTEGRATION_IDS,
    );
    expect(new Set(connections.map((connection) => connection.id)).size).toBe(6);
  });

  it("uses public Skill/MCP addresses and only verified native host commands", () => {
    for (const connection of connections) {
      if (connection.id === "workbuddy") {
        expect(connection.status.detail).toContain("GitHub");
        expect(connection.status.detail).toContain("ZIP");
        expect(connection.sources).toContainEqual({
          label: "Attention Skill · GitHub",
          url: "https://github.com/EthanSMC/Attention/blob/main/apps/web/public/skills/attention/SKILL.md",
        });
        expect(connection.skillUrl).toBe(
          `https://attention.example${ATTENTION_WORKBUDDY_SKILL_BUNDLE_PUBLIC_PATH}`,
        );
        expect(connection.skillLabel).toBe("WorkBuddy Skill bundle");
        expect(connection.skillDownloadFilename).toMatch(/\.zip$/u);
        expect(connection.skillSha256).toBe(
          ATTENTION_WORKBUDDY_SKILL_BUNDLE_SHA256,
        );
      } else {
        expect(connection.skillUrl).toBe(
          "https://attention.example/skills/attention/SKILL.md",
        );
        expect(connection.skillLabel).toBe("Skill 文件");
        expect(connection.skillSha256).toBe(ATTENTION_SKILL_DOCUMENT_SHA256);
      }
      expect(connection.mcpUrl).toBe("https://attention.example/mcp");
      expect(connection.sources.every((source) => source.url.startsWith("https://"))).toBe(
        true,
      );
      expect(connection.commands.map((command) => command.value).join("\n")).not.toMatch(
        /\{(?:attention_origin|mcp_url|skill_url|skill_bundle_url|attention_skill_directory)\}|<attention-|^attention (configure|doctor)/mu,
      );
    }

    expect(
      connections
        .find((connection) => connection.id === "codex")
        ?.commands.some((command) => command.value === "codex mcp get attention --json"),
    ).toBe(true);
    expect(
      connections
        .find((connection) => connection.id === "deepseek")
        ?.commands.map((command) => command.value),
    ).toEqual(
      expect.arrayContaining([
        "dsh plugin --profile web add @attention/dsh",
        "dsh --profile web --dump-config",
      ]),
    );
    expect(
      connections.find((connection) => connection.id === "deepseek")
        ?.manualChecklist,
    ).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("ATTENTION_API_KEY"),
      }),
    ]);
    expect(
      connections
        .find((connection) => connection.id === "codex")
        ?.commands.find((command) => command.value === "codex mcp get attention --json")
        ?.label,
    ).toBe("查看 MCP 配置");
    expect(
      connections
        .find((connection) => connection.id === "openclaw")
        ?.commands.some(
          (command) =>
            command.value ===
            "openclaw skills install ./attention-skill --as attention",
        ),
    ).toBe(true);
    expect(
      connections
        .find((connection) => connection.id === "openclaw")
        ?.commands.some(
          (command) =>
            command.value ===
            "openclaw skills install .\\attention-skill --as attention",
        ),
    ).toBe(true);
    expect(
      connections.find((connection) => connection.id === "openclaw")?.skillPaths,
    ).toEqual([
      {
        label: "macOS / Linux",
        value: "./attention-skill/SKILL.md",
      },
      {
        label: "Windows",
        value: ".\\attention-skill\\SKILL.md",
      },
    ]);
    expect(
      connections.find((connection) => connection.id === "codex")?.skillPaths,
    ).toEqual([
      {
        label: "macOS / Linux",
        value: "~/.agents/skills/attention/SKILL.md",
      },
      {
        label: "Windows",
        value: "%USERPROFILE%\\.agents\\skills\\attention\\SKILL.md",
      },
    ]);
    expect(
      connections.find((connection) => connection.id === "claude-code")
        ?.skillPaths,
    ).toEqual([
      {
        label: "macOS / Linux",
        value: "~/.claude/skills/attention/SKILL.md",
      },
      {
        label: "Windows",
        value: "%USERPROFILE%\\.claude\\skills\\attention\\SKILL.md",
      },
    ]);
    expect(
      connections.find((connection) => connection.id === "hermes")?.commands,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "添加并授权 MCP" }),
      ]),
    );
    expect(
      connections
        .find((connection) => connection.id === "hermes")
        ?.commands.some((command) => command.value === "hermes mcp login attention"),
    ).toBe(false);
    expect(
      connections.find((connection) => connection.id === "workbuddy")?.commands,
    ).toEqual([]);
    expect(
      Object.fromEntries(
        connections.map((connection) => [
          connection.id,
          connection.minimumVersion,
        ]),
      ),
    ).toMatchObject({
      "claude-code": "2.1.226",
      openclaw: "2026.5.12",
      workbuddy: "4.8.2",
    });
  });

  it("exposes channel setup without hosted-channel or connection-state claims", () => {
    const publicCopy = JSON.stringify(connections);
    // Local bridge setup copy is allowed; hosted-channel framing and any
    // connection-state claim remain forbidden.
    expect(publicCopy).not.toMatch(
      /Hosted Channel|托管 Channel|微信已连接|渠道已连接|已绑定|绑定成功|已验证|连接成功|最后在线|connection state/u,
    );

    for (const id of ["codex", "claude-code"] as const) {
      const setup = connections.find((connection) => connection.id === id)
        ?.channelSetup;
      expect(setup).not.toBeNull();
      expect(setup?.command).toBe(
        `attention channel start ${id} --origin https://attention.example --background`,
      );
      expect(setup?.command).not.toMatch(/\{attention_origin\}/u);
      expect(setup?.prerequisites.length ?? 0).toBeGreaterThan(0);
      expect(setup?.detail).toMatch(/Runtime Reporter/u);
      expect(setup?.detail).toMatch(/不上传消息、链接或凭据/u);
    }

    for (const id of ["openclaw", "hermes"] as const) {
      const setup = connections.find((connection) => connection.id === id)
        ?.channelSetup;
      expect(setup).not.toBeNull();
      expect(setup?.command).toBeNull();
    }

    const workbuddySetup = connections.find(
      (connection) => connection.id === "workbuddy",
    )?.channelSetup;
    expect(workbuddySetup).not.toBeNull();
    expect(workbuddySetup?.command).toBeNull();
    expect(workbuddySetup?.detail).toMatch(/无法验证/u);
  });
});
