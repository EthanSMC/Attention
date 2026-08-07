import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { projectAgentConnections } from "../server/agent-connection-projection";

describe("ConnectionManager", () => {
  it("renders all five local Agent choices without a remote-channel claim", () => {
    const connections = projectAgentConnections({
      mcpUrl: "https://attention.example/mcp",
      origin: "https://attention.example",
    });
    const componentSource = readFileSync(
      new URL("./connection-manager.tsx", import.meta.url),
      "utf8",
    );

    for (const name of [
      "OpenClaw",
      "Hermes Agent",
      "Codex",
      "Claude Code",
      "WorkBuddy",
    ]) {
      expect(connections.some((connection) => connection.displayName === name)).toBe(
        true,
      );
    }
    expect(componentSource).toMatch(/agentConnections\.map/u);
    expect(componentSource).toContain("Attention MCP");
    expect(componentSource).toContain("selectedAgent.skillLabel");
    expect(componentSource).toContain("selectedAgent.skillPaths.map");
    expect(componentSource).toContain("selectedAgent.minimumVersion");
    expect(componentSource).toContain("selectedAgent.skillSha256");
    expect(componentSource).toContain("download={selectedAgent.skillDownloadFilename}");
    expect(componentSource).toContain("capabilityManifestUrl");
    expect(componentSource).toContain("个业务工具 · 权限随账号权益实时变化");
    expect(componentSource).toContain("查看机器清单");
    expect(componentSource).toContain("WorkBuddy 安装步骤");
    expect(componentSource).toContain("selectedAgent.manualChecklist.map");
    expect(componentSource).toContain("selectedAgent.acceptance.toolName");
    expect(componentSource).toContain("不会执行远端脚本");
    expect(
      connections.every((connection) =>
        connection.acceptance.detail.includes("只有成功返回当前 Attention 账号信息"),
      ),
    ).toBe(true);
    expect(
      connections.find((connection) => connection.id === "workbuddy")?.skillUrl,
    ).toMatch(/attention-workbuddy-\d+\.\d+\.\d+\.zip$/u);
    expect(componentSource).not.toMatch(
      /Hosted Channel|托管 Channel|微信|agent-channel-boundary/u,
    );
  });

  it("distinguishes current API Keys from legacy keys that need rotation", () => {
    const componentSource = readFileSync(
      new URL("./connection-manager.tsx", import.meta.url),
      "utf8",
    );

    expect(componentSource).toContain("新建 Key 会包含当前完整权限范围");
    expect(componentSource).toContain("旧 Key 仍以创建时的权限范围为上限");
    expect(componentSource).toContain('item.needsRotation ? "需轮换" : "当前完整"');
    expect(componentSource).not.toContain("所有 Key 类型相同，实际能力跟随账号实时变化");
  });
});
