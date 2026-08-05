export type WechatMessageMode = "compatible" | "plaintext" | "safe";

export interface WechatAdapterConfig {
  appId: string;
  appSecret: string;
  asyncReplyProvider: "customer_service" | "disabled";
  attentionApiBaseUrl: string;
  attentionApiSecret: string;
  callbackPath: string;
  callbackToken: string;
  encodingAesKey: string;
  host: string;
  maxBodyBytes: number;
  maxTimestampSkewSeconds: number;
  messageMode: WechatMessageMode;
  originalId: string | null;
  pendingPollIntervalMs: number;
  pendingPollTimeoutMs: number;
  port: number;
  syncTimeoutMs: number;
  wechatApiBaseUrl: string;
}

export interface NormalizedWechatMessage {
  action: "agent" | "collect";
  appId: string;
  channelMessageId: string;
  createTime: number;
  fromUser: string;
  rawInput: string;
  toUser: string;
}

export interface ChannelGatewayReply {
  pendingRequestId: string | null;
  status: "binding_required" | "completed" | "membership_required";
  text: string;
}

export interface AsyncReplySender {
  sendText(openId: string, text: string): Promise<void>;
}

export interface SafeLogger {
  error(event: string, fields?: Record<string, boolean | number | string>): void;
  info(event: string, fields?: Record<string, boolean | number | string>): void;
  warn(event: string, fields?: Record<string, boolean | number | string>): void;
}
