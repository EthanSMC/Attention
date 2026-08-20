import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentPageContent } from "./agent-page-content";

describe("AgentPageContent", () => {
  it("puts local setup first and keeps cloud Agent explicitly in development", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentPageContent, {
        agentConnectionStatus: "not_connected",
        agentConnectionPrompt: "Connect Attention",
        agentDocumentationUrl: "/doc",
        bridgeConnectionStatus: "not_configured",
        supportedAgents: ["Codex", "Claude Code"],
        wechatBindingStatus: "not_bound",
      }),
    );

    expect(markup).toContain("本地 Agent");
    expect(markup).toContain("一键连接本地Agent");
    expect(markup).toContain("查看手动接入文档");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("云端 Agent");
    expect(markup).toContain("开发中");
    expect(markup).toContain("本地连接链路");
    expect(markup).toContain("Attention 到微信");
    expect(markup).toContain("双向表示消息与结果往返");
    expect(markup.indexOf("当前支持")).toBeLessThan(markup.indexOf("本地连接链路"));
    expect(markup).toContain("连接 Agent");
    expect(markup).toContain("本地 Bridge");
    expect(markup).toContain("配置 Bridge");
    expect(markup).toContain("绑定微信");
    expect(markup).toContain("未绑定");
    expect(markup).toContain(
      'aria-label="Attention、本地 Agent、本地 Bridge 和微信的双向连接状态"',
    );
  });
});
