import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as connectionManagerModule from "./connection-manager";

const { ConnectionManager } = connectionManagerModule;

const mcpGroups = [
  {
    clientName: "Codex",
    connections: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        label: "工作 MacBook",
        lastAuthorizedAt: "2026-08-11T10:00:00.000Z",
        lastUsedAt: "2026-08-11T10:30:00.000Z",
        scopes: ["collection:read", "collection:write"],
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        label: "家里 Mac mini",
        lastAuthorizedAt: "2026-08-10T10:00:00.000Z",
        lastUsedAt: null,
        scopes: ["collection:read"],
      },
      {
        id: "10000000-0000-4000-8000-000000000003",
        label: "测试容器",
        lastAuthorizedAt: "2026-08-09T10:00:00.000Z",
        lastUsedAt: null,
        scopes: ["profile:read"],
      },
    ],
  },
];

function renderManager(): string {
  return renderToStaticMarkup(createElement(
    ConnectionManager as ComponentType<Record<string, unknown>>,
    {
      agentConnectionPrompt: "Connect Attention",
      agentDocumentationUrl: "https://attention.example/doc",
      localChannelRuntimes: [],
      mcpOAuthConnections: mcpGroups,
      oauthConnections: [],
      pats: [],
    },
  ));
}

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

  it("renders one collapsed app group with every logical connection independently actionable", () => {
    const markup = renderManager();

    expect(markup).toContain("Codex · 3 个连接");
    expect(markup).toContain("工作 MacBook");
    expect(markup).toContain("家里 Mac mini");
    expect(markup).toContain("测试容器");
    expect(markup).toContain("权限范围（2）");
    expect(markup).toContain("collection:read");
    expect(markup).toMatch(/<details[^>]*class="oauth-connection-group"(?![^>]*open)/u);
    expect(markup).toContain('aria-label="撤销连接：工作 MacBook"');
    expect(markup).toContain("撤销全部");
    expect(markup).not.toContain("Attention Local Channel Runtime");
    expect(markup).not.toContain("Runtime OAuth");
  });

  it("renders the destructive group confirmation with the exact connection count", () => {
    const candidate = Reflect.get(
      connectionManagerModule,
      "OAuthGroupRevokeModal",
    ) as ComponentType<Record<string, unknown>> | undefined;
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    const markup = renderToStaticMarkup(createElement(candidate, {
      busy: false,
      clientName: "Codex",
      connectionCount: 3,
      onCancel: () => undefined,
      onConfirm: () => undefined,
    }));
    expect(markup).toContain("撤销 Codex 的 3 个连接？");
    expect(markup).toContain("这 3 个连接会立即停止访问 Attention");
  });
});
