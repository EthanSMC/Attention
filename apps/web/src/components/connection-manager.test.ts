import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import * as connectionManagerModule from "./connection-manager";

const { ConnectionManager } = connectionManagerModule;

const agentGroups = [
  {
    audience: "attention-mcp" as const,
    clientName: "Codex",
    connections: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        deviceName: null,
        label: "工作 MacBook",
        lastAuthorizedAt: "2026-08-11T10:00:00.000Z",
        lastUsedAt: "2026-08-11T10:30:00.000Z",
        scopes: ["collection:read", "collection:write"],
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        deviceName: null,
        label: "家里 Mac mini",
        lastAuthorizedAt: "2026-08-10T10:00:00.000Z",
        lastUsedAt: null,
        scopes: ["collection:read"],
      },
      {
        id: "10000000-0000-4000-8000-000000000003",
        deviceName: null,
        label: "测试容器",
        lastAuthorizedAt: "2026-08-09T10:00:00.000Z",
        lastUsedAt: null,
        scopes: ["profile:read"],
      },
    ],
  },
  {
    audience: "attention-sync" as const,
    clientName: "Codex",
    connections: [
      {
        deviceName: null,
        id: "10000000-0000-4000-8000-000000000004",
        label: "Codex Sync",
        lastAuthorizedAt: "2026-08-11T08:00:00.000Z",
        lastUsedAt: null,
        scopes: ["sync:read", "sync:write"],
      },
    ],
  },
  {
    audience: "attention-channel-runtime" as const,
    clientName: "Attention Local Channel Runtime",
    connections: [
      {
        deviceName: "Ethan MacBook",
        id: "20000000-0000-4000-8000-000000000001",
        label: "工作电脑",
        lastAuthorizedAt: "2026-08-11T09:00:00.000Z",
        lastUsedAt: "2026-08-11T09:30:00.000Z",
        scopes: ["runtime:heartbeat"],
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
      oauthConnections: [],
      agentOAuthConnections: agentGroups,
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

  it("renders the reported Bridge version and public update state", () => {
    const markup = renderToStaticMarkup(createElement(
      ConnectionManager as ComponentType<Record<string, unknown>>,
      {
        agentConnectionPrompt: "Connect Attention",
        agentDocumentationUrl: "https://attention.example/doc",
        localChannelRuntimes: [{
          adapterVersion: "0.3.5",
          deviceName: "Ethan MacBook",
          hostName: "Codex",
          lastSeenAt: null,
          lastSuccessfulMessageAt: null,
          pendingInbound: 0,
          pendingOutbound: 0,
          status: "online",
          version: { latestVersion: "0.3.6", status: "recommended" },
        }],
        agentOAuthConnections: [],
        pats: [],
      },
    ));

    expect(markup).toContain("Bridge");
    expect(markup).toContain("0.3.5 · 建议更新");
    expect(markup).not.toContain("artifactPath");
  });

  it("renders every OAuth audience with readable permissions and no raw scopes", () => {
    const markup = renderManager();

    expect(markup).toContain("Codex · 3 个连接");
    expect(markup).toContain("工作 MacBook");
    expect(markup).toContain("家里 Mac mini");
    expect(markup).toContain("测试容器");
    expect(markup).toContain("Codex Sync");
    expect(markup).toContain("工作电脑");
    expect(markup).toContain("新增私人收藏");
    expect(markup).toContain("同步你的私人收藏");
    expect(markup).toContain("上报运行状态");
    expect(markup).not.toContain("collection:read");
    expect(markup).not.toContain("sync:read");
    expect(markup).not.toContain("runtime:heartbeat");
    expect(markup).not.toContain("<code");
    expect(markup).toMatch(/<details[^>]*class="oauth-connection-group"(?![^>]*open)/u);
    expect(markup).toContain('aria-label="撤销连接：工作 MacBook"');
    expect(markup).toContain("撤销全部");
    expect(markup).toContain("Attention Local Channel Runtime");
    expect(markup).toContain("本地 Runtime");
    expect(markup).toContain("同步");
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

  it("submits the exact logical connection snapshot that supplied the confirmation count", async () => {
    const candidate = Reflect.get(
      connectionManagerModule,
      "requestOAuthGroupSnapshotRevoke",
    ) as ((
      group: (typeof agentGroups)[number],
      request: typeof fetch,
    ) => Promise<string>) | undefined;
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;
    let requestBody: unknown;

    const result = await candidate(agentGroups[0]!, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ revoked_count: 3 }), { status: 200 });
    });

    expect(requestBody).toEqual({
      audience: "attention-mcp",
      client_name: "Codex",
      connection_ids: [
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000003",
      ],
    });
    expect(result).toBe("revoked");
  });

  it("distinguishes a stale confirmed snapshot from an ambiguous server failure", async () => {
    const candidate = Reflect.get(
      connectionManagerModule,
      "requestOAuthGroupSnapshotRevoke",
    ) as ((
      group: (typeof agentGroups)[number],
      request: typeof fetch,
    ) => Promise<string>) | undefined;
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    await expect(candidate(agentGroups[0]!, async () => new Response(
      JSON.stringify({ error: { code: "oauth_connection_snapshot_stale" } }),
      { status: 409 },
    ))).resolves.toBe("stale");

    const feedbackCandidate = Reflect.get(
      connectionManagerModule,
      "oauthGroupRevokeFailureMessage",
    ) as ((outcome: string) => string) | undefined;
    expect(feedbackCandidate).toBeTypeOf("function");
    if (!feedbackCandidate) return;
    expect(feedbackCandidate("stale")).toBe("连接列表已变化，请刷新后重试。");
    await expect(candidate(agentGroups[0]!, async () => {
      throw new Error("connection_lost");
    })).resolves.toBe("unknown");
    expect(feedbackCandidate("unknown")).toBe(
      "网络连接中断，撤销结果无法确认。请刷新连接列表后再操作。",
    );
  });

  it("renders a labeled inline rename editor with save and cancel actions", () => {
    const candidate = Reflect.get(
      connectionManagerModule,
      "OAuthConnectionRenameEditor",
    ) as ComponentType<Record<string, unknown>> | undefined;
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    const markup = renderToStaticMarkup(createElement(candidate, {
      busy: false,
      error: null,
      label: "工作 MacBook",
      onCancel: () => undefined,
      onChange: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toContain("连接名称");
    expect(markup).toContain('value="工作 MacBook"');
    expect(markup).toContain(">保存</button>");
    expect(markup).toContain(">取消</button>");
  });

  it("maps rename responses and preserves a conflicting typed label", async () => {
    const requestRename = Reflect.get(
      connectionManagerModule,
      "requestOAuthConnectionRename",
    ) as ((
      connectionId: string,
      label: string,
      request: typeof fetch,
    ) => Promise<string>) | undefined;
    expect(requestRename).toBeTypeOf("function");
    if (!requestRename) return;

    const request = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      error: { code: "oauth_connection_name_conflict" },
    }), { status: 409 }));
    await expect(requestRename(
      "10000000-0000-4000-8000-000000000001",
      "已有名称",
      request,
    )).resolves.toBe("conflict");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      label: "已有名称",
    });
  });

  it("updates only the renamed connection in the visible groups", () => {
    const applyRename = Reflect.get(
      connectionManagerModule,
      "applyOAuthConnectionRename",
    ) as ((
      groups: typeof agentGroups,
      connectionId: string,
      label: string,
    ) => typeof agentGroups) | undefined;
    expect(applyRename).toBeTypeOf("function");
    if (!applyRename) return;

    const renamed = applyRename(
      agentGroups,
      "10000000-0000-4000-8000-000000000002",
      "家中电脑",
    );
    expect(renamed[0]?.connections.map(({ label }) => label)).toEqual([
      "工作 MacBook",
      "家中电脑",
      "测试容器",
    ]);
    expect(agentGroups[0]?.connections[1]?.label).toBe("家里 Mac mini");
  });
});
