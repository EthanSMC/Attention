import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { projectAgentConnections } from "../server/agent-connection-projection";
import { buildAgentConnectionPrompt } from "../server/agent-connection-prompt";

describe("public Agent installation guide", () => {
  it("publishes a public index and a separate document for every Agent", () => {
    const indexSource = readFileSync(
      new URL("../app/doc/page.tsx", import.meta.url),
      "utf8",
    );
    const documentPageSource = readFileSync(
      new URL("../app/doc/[agent]/page.tsx", import.meta.url),
      "utf8",
    );
    const documentSource = readFileSync(
      new URL("./agent-install-document.tsx", import.meta.url),
      "utf8",
    );
    const skillSource = readFileSync(
      new URL("./agent-skill-document.tsx", import.meta.url),
      "utf8",
    );
    const navigationSource = readFileSync(
      new URL("./agent-doc-navigation.tsx", import.meta.url),
      "utf8",
    );
    const connections = projectAgentConnections({
      mcpUrl: "https://attention.example/mcp",
      origin: "https://attention.example",
    });

    expect(connections).toHaveLength(5);
    expect(indexSource).toContain("projectAgentConnections");
    expect(indexSource).toContain("agentConnections.map");
    expect(indexSource).toContain("`/doc/${agent.id}`");
    expect(indexSource).toContain("<AgentDocNavigation");
    expect(indexSource).toContain('className="agent-doc-layout"');
    expect(indexSource).not.toContain("getPagePrincipal");
    expect(indexSource).not.toContain("LoginModuleFallback");
    expect(documentPageSource).toContain("generateStaticParams");
    expect(documentPageSource).toContain("<AgentInstallDocument");
    expect(documentSource).toContain("<AgentDocNavigation");
    expect(documentSource).toContain("connection.commands.map");
    expect(documentSource).toContain("connection.manualChecklist.map");
    expect(documentSource).toContain("connection.acceptance.toolName");
    expect(documentSource).toContain("capabilityManifestUrl");
    expect(documentSource).toContain("OAuth");
    expect(documentSource).toContain("MCP");
    expect(documentSource).toContain("统一的 Attention Skill");
    expect(documentSource).toContain('href="/doc/skill"');
    expect(skillSource).toContain("所有 Agent 使用同一份 Skill");
    expect(skillSource).toContain('activeSection="skill"');
    expect(navigationSource).toContain("概览");
    expect(navigationSource).toContain("agentLinks.map");
    expect(navigationSource).toContain("activeAgentId");
  });

  it("removes the product chrome from the standalone documentation route", () => {
    const navigationSource = readFileSync(
      new URL("./site-navigation.tsx", import.meta.url),
      "utf8",
    );

    expect(navigationSource).toContain('pathname.startsWith("/doc")');
  });

  it("creates one copyable prompt that routes the Agent to its own document", () => {
    const prompt = buildAgentConnectionPrompt("https://attention.example/doc");

    expect(prompt).toContain("https://attention.example/doc");
    expect(prompt).toContain("识别你当前运行的 Agent 宿主");
    expect(prompt).toContain("只进入对应宿主的独立文档");
    expect(prompt).toContain("attention_get_my_account");
    expect(prompt).toContain("微信接入");
    expect(prompt).toContain("attention channel start");
    expect(prompt).toContain("--background");
    expect(prompt).toContain("扫码");
    expect(prompt).toContain("持续读取命令输出");
    expect(prompt).toContain("二维码首次出现时立即");
    expect(prompt).toContain("不要等待命令结束");
    expect(prompt).toContain("发送一条真实链接");
    expect(prompt).toContain("我的收藏");
    expect(prompt).not.toMatch(/API Key：|token：/u);
  });
});
