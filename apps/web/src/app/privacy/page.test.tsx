import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PrivacyPage from "./page";

describe("PrivacyPage", () => {
  it("explains the privacy boundary for third-party OAuth clients", () => {
    const markup = renderToStaticMarkup(<PrivacyPage />);

    expect(markup).toContain("第三方 OAuth 客户端");
    expect(markup).toContain("只会在你允许的权限和当前账号权益范围内");
    expect(markup).toContain("不会获得你的 Attention 网站登录 Session");
    expect(markup).toContain("由第三方按照其隐私政策负责处理");
    expect(markup).toContain("连接与授权");
    expect(markup).toContain("撤销只会阻止未来访问");
    expect(markup).toContain("不会删除第三方此前已经接收的数据");
  });
});
