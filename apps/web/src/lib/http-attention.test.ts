import { afterEach, describe, expect, it, vi } from "vitest";

import { httpCollectAdapter } from "./http-attention";

afterEach(() => vi.unstubAllGlobals());

describe("collection failure explanations", () => {
  it.each([
    ["non_content_target", "未识别到可收藏的内容页，请提供笔记或文章的分享链接。"],
    ["no_content_link", "没有找到可收藏的 HTTP(S) 内容链接。"],
    ["invalid_url", "链接格式不完整，请复制公开内容页的完整地址。"],
    ["unknown https://example.org/private", "暂时无法处理这个链接，请确认是公开内容页后重试。"],
    ["constructor", "暂时无法处理这个链接，请确认是公开内容页后重试。"],
    ["__proto__", "暂时无法处理这个链接，请确认是公开内容页后重试。"],
  ])("explains %s without guessing what the target page contains", async (errorCode, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      attempt_id: "fixture-attempt",
      received_at: "2026-11-03T08:50:00.000Z",
      status: "invalid",
      error_code: errorCode,
    })));

    expect(await httpCollectAdapter.submit({
      rawInput: "https://xhslink.cn/o/fixture", idempotencyKey: "fixture-idempotency", visibility: "private",
    })).toEqual({ status: "invalid", reason });
  });
});
