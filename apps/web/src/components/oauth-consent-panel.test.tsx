import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OAuthConsentPresentation } from "../lib/oauth-consent-presentation";
import { OAuthConsentPanel } from "./oauth-consent-panel";

const fields = {
  client_id: "client-1",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256" as const,
  redirect_uri: "http://127.0.0.1:43820/callback",
  resource: "https://attention.example/mcp",
  response_type: "code" as const,
  scope: "profile:read collection:read",
  state: "opaque-state",
};

const presentation: OAuthConsentPresentation = {
  audienceSummary: "让 Agent 在你允许的范围内使用 Attention。",
  dataItems: ["你的公开资料", "你的私人收藏链接、收藏状态和基础信息"],
  permissionGroups: [
    {
      description: "查看你的公开资料、私人收藏。",
      id: "account-and-collections",
      risk: "standard",
      title: "查看账号与私人收藏",
    },
  ],
};

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ");
}

describe("OAuthConsentPanel", () => {
  it("renders the user decision in the approved information order", () => {
    const markup = renderToStaticMarkup(
      <OAuthConsentPanel
        accountLabel="ethan@example.com"
        cancelHref="/oauth/authorize/cancel?client_id=client-1"
        clientName="Codex"
        fields={fields}
        presentation={presentation}
      />,
    );

    expect(markup).toContain("Codex 想要访问你的 Attention");
    expect(markup).toContain("当前使用 ethan@example.com");
    expect(markup).toContain("查看账号与私人收藏");
    expect(markup).toContain("授权后可能接触的数据");
    expect(markup).toContain("Attention 登录 Session 不会交给 Codex");
    expect(markup).toContain('href="/account/connections"');
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain(">允许并连接</button>");
    expect(markup).toContain(">拒绝</a>");
  });

  it("keeps protocol values hidden and renders no identity decoration", () => {
    const markup = renderToStaticMarkup(
      <OAuthConsentPanel
        accountLabel="ethan@example.com"
        cancelHref="/oauth/authorize/cancel?client_id=client-1"
        clientName="Codex"
        fields={fields}
        presentation={presentation}
      />,
    );
    const text = visibleText(markup);

    expect(markup).not.toContain("authorization-card__client");
    expect(markup).not.toContain("connection_label");
    expect(markup).not.toContain("<img");
    expect(text).not.toContain(fields.redirect_uri);
    expect(text).not.toContain(fields.resource);
    expect(text).not.toContain(fields.scope);
    expect(text).not.toContain(fields.code_challenge_method);
    expect(markup).toContain(`value="${fields.redirect_uri}"`);
    expect(markup).toContain(`value="${fields.resource}"`);
  });
});
