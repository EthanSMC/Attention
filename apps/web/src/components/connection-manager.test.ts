import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ConnectionManager", () => {
  it("keeps Agent setup concise and hands detailed work to the public guide", () => {
    const componentSource = readFileSync(
      new URL("./connection-manager.tsx", import.meta.url),
      "utf8",
    );

    expect(componentSource).toContain("agentConnectionPrompt");
    expect(componentSource).toContain("agentDocumentationUrl");
    expect(componentSource).toContain("复制给 AI");
    expect(componentSource).toContain("查看接入文档");
    expect(componentSource).toContain('target="_blank"');
    expect(componentSource).toContain("TransientFeedback");
    expect(componentSource).not.toContain("connection-toast");
    expect(componentSource).not.toContain("selectedAgent.commands");
    expect(componentSource).not.toContain("agentConnections.map");
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

  it("shows only privacy-safe local Channel runtime facts", () => {
    const componentSource = readFileSync(
      new URL("./connection-manager.tsx", import.meta.url),
      "utf8",
    );

    expect(componentSource).toContain("localChannelRuntimes");
    expect(componentSource).toContain("本地 Channel");
    expect(componentSource).toContain("最后在线");
    expect(componentSource).toContain("上次完成");
    expect(componentSource).toContain("待处理");
    expect(componentSource).not.toMatch(
      /threadId|messageRef|fingerprint|providerAccount|accessToken/u,
    );
  });
});
