import {
  oauthScopesByAudience,
  type OAuthAudience,
  type OAuthScope,
} from "@attention/auth";
import { describe, expect, it } from "vitest";

import {
  buildOAuthConsentPresentation,
  OAuthConsentPresentationError,
} from "./oauth-consent-presentation";

describe.each(
  Object.entries(oauthScopesByAudience) as Array<
    [OAuthAudience, readonly OAuthScope[]]
  >,
)("OAuth consent presentation for %s", (audience, scopes) => {
  it("covers every supported scope without exposing protocol names", () => {
    const presentation = buildOAuthConsentPresentation(audience, scopes);

    expect(presentation.permissionGroups.length).toBeGreaterThan(0);
    expect(presentation.dataItems.length).toBeGreaterThan(0);
    const visibleCopy = JSON.stringify(presentation);
    for (const scope of scopes) expect(visibleCopy).not.toContain(scope);
  });
});

describe("MCP consent copy", () => {
  it("adapts digest language to read-only access", () => {
    const presentation = buildOAuthConsentPresentation("attention-mcp", [
      "digest:read",
    ]);

    expect(presentation.permissionGroups).toEqual([
      expect.objectContaining({
        title: "查看和修改日报",
        description: "查看你的日报订阅和发送时间设置。",
        risk: "standard",
      }),
    ]);
  });

  it("adapts digest language when changes are allowed", () => {
    const presentation = buildOAuthConsentPresentation("attention-mcp", [
      "digest:read",
      "digest:write",
    ]);

    expect(presentation.permissionGroups).toEqual([
      expect.objectContaining({
        title: "查看和修改日报",
        description: "查看并修改你的日报订阅和发送时间设置。",
        risk: "write",
      }),
    ]);
  });

  it("shows irreversible voting language only for vote access", () => {
    const withoutVote = buildOAuthConsentPresentation("attention-mcp", [
      "moderation:court:read",
    ]);
    const withVote = buildOAuthConsentPresentation("attention-mcp", [
      "moderation:court:vote",
    ]);

    expect(JSON.stringify(withoutVote)).not.toContain("不可更改");
    expect(JSON.stringify(withVote)).toContain("不可更改");
    expect(withVote.permissionGroups[0]?.risk).toBe("irreversible");
  });

  it("only lists data represented by requested scopes", () => {
    const presentation = buildOAuthConsentPresentation("attention-mcp", [
      "collection:write",
    ]);

    expect(presentation.dataItems).toEqual(["你新增的私人收藏链接和基础信息"]);
    expect(JSON.stringify(presentation)).not.toContain("日报");
    expect(JSON.stringify(presentation)).not.toContain("治理");
  });
});

describe("Sync consent copy", () => {
  it.each([
    [["sync:read"] as const, "下载你的私人收藏变更。", "standard"],
    [["sync:write"] as const, "上传你的私人收藏变更。", "write"],
    [
      ["sync:read", "sync:write"] as const,
      "下载并上传你的私人收藏变更。",
      "write",
    ],
  ])("adapts to the requested sync direction", (scopes, description, risk) => {
    const presentation = buildOAuthConsentPresentation("attention-sync", scopes);

    expect(presentation.permissionGroups).toEqual([
      expect.objectContaining({
        title: "同步你的私人收藏",
        description,
        risk,
      }),
    ]);
  });
});

describe("Runtime consent copy", () => {
  it("states notification data and the sensitive local data it excludes", () => {
    const presentation = buildOAuthConsentPresentation(
      "attention-channel-runtime",
      oauthScopesByAudience["attention-channel-runtime"],
    );

    expect(presentation.permissionGroups).toContainEqual(
      expect.objectContaining({ title: "接收收藏完成通知", risk: "standard" }),
    );
    expect(presentation.dataItems).toContain(
      "你通过微信收藏内容的标题、原始链接和摘要",
    );
    expect(presentation.dataItems).toContain(
      "不会接触微信对话内容、服务商凭据或本地 Session",
    );
    expect(presentation.dataItems).not.toContain(
      "不会接触对话内容、私人收藏、服务商凭据或本地 Session",
    );
  });
});

it("fails closed when a scope is not mapped", () => {
  expect(() =>
    buildOAuthConsentPresentation("attention-mcp", [
      "unknown:scope" as OAuthScope,
    ]),
  ).toThrow(OAuthConsentPresentationError);
});

it("fails closed when a scope belongs to another audience", () => {
  expect(() =>
    buildOAuthConsentPresentation("attention-sync", ["profile:read"]),
  ).toThrow(OAuthConsentPresentationError);
});
