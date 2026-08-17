import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  groupOAuthScopes,
  OAuthScopeDisclosure,
} from "./oauth-scope-disclosure";

const scopes = [
  "ai:search",
  "collection:read",
  "collection:write",
  "digest:read",
  "moderation:court:read",
  "profile:read",
  "public:read",
  "subscription:read",
];

describe("OAuthScopeDisclosure", () => {
  it("groups one shared permission model without dropping exact scopes", () => {
    const groups = groupOAuthScopes(scopes);
    const markup = renderToStaticMarkup(createElement(OAuthScopeDisclosure, { scopes }));

    expect(groups.map((group) => group.title)).toEqual([
      "收藏与公开内容",
      "AI 与日报",
      "社区治理",
      "账号",
    ]);
    for (const scope of scopes) {
      expect(markup).toContain(scope);
    }
    expect(markup).toContain("读取你的个人收藏");
    expect(markup).toContain("使用托管 AI 检索");
  });
});
