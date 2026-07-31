import type { InputEnvelope } from "@attention/contracts";

const RECEIVED_AT = "2026-07-31T10:00:00+08:00";

function webTextEnvelope(rawPayload: string): InputEnvelope {
  return {
    channel: "web",
    sender_account_id: "account_fixture",
    channel_message_id: `message_${rawPayload.length}`,
    payload_type: "text",
    raw_payload: rawPayload,
    received_at: RECEIVED_AT,
    parser_version: "v1"
  };
}

export const collectorFixtures = {
  douyinShareEnvelope: webTextEnvelope(
    "7.21 复制打开抖音，看看【Attention 测试视频】 https://v.douyin.com/iRFixture/ 03/16 abc:/"
  ),
  xiaohongshuShareEnvelope: webTextEnvelope(
    "这个 AI 笔记很有用 😆 http://xhslink.com/aBcDeFg，复制本条信息打开【小红书】查看精彩内容！"
  ),
  wechatShareEnvelope: webTextEnvelope(
    "推荐阅读：https://mp.weixin.qq.com/s?__biz=MzA1Fixture%3D%3D&mid=1234567890&idx=1&sn=publicfixture。"
  ),
  chinesePunctuationEnvelope: webTextEnvelope(
    "先看（https://example.com/alpha?x=1），再看【https://example.org/beta】。"
  ),
  zeroWidthEnvelope: webTextEnvelope(
    "https://exa\u200Bmple.com/path\u2060?from=share"
  ),
  hostSpoofUrls: [
    "https://douyin.com.evil.example/video/123456",
    "https://www.xiaohongshu.com.evil.example/explore/abcdef12",
    "https://mp.weixin.qq.com.evil.example/s?__biz=x&mid=1&idx=1",
    "https://www.douyin.com@evil.example/video/123456"
  ]
} as const;
