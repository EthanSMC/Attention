import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WebsiteAgentConsole } from "./website-agent-console";

describe("website agent consent surface", () => {
  it("requires explicit model-data consent and defaults all capabilities to unchecked", () => {
    const markup = renderToStaticMarkup(createElement(WebsiteAgentConsole));
    expect(markup).toMatch(/<input(?=[^>]*name="data_consent")(?=[^>]*required="")[^>]*>/u);
    expect(markup).toContain('name="collect"');
    expect(markup).toContain('name="read_sources"');
    expect(markup).not.toContain('checked=""');
    expect(markup).toContain("DeepSeek");
    expect(markup).toContain("私密收藏");
    expect(markup).toContain('href="/account"');
    expect(markup).not.toContain("停止等待");
  });
});
