import { serve } from "@hono/node-server";

import { WechatAccessTokenProvider, WechatCustomerServiceSender } from "./access-token.js";
import { createWechatApp } from "./app.js";
import { HttpAttentionChannelGateway } from "./attention-client.js";
import { loadWechatAdapterConfig } from "./config.js";
import { MessageDeliveryCoordinator } from "./delivery.js";
import { safeLogger } from "./logger.js";

export function startWechatAdapter(): ReturnType<typeof serve> {
  const config = loadWechatAdapterConfig();
  const gateway = new HttpAttentionChannelGateway({
    apiBaseUrl: config.attentionApiBaseUrl,
    apiSecret: config.attentionApiSecret,
    pendingPollIntervalMs: config.pendingPollIntervalMs,
    pendingPollTimeoutMs: config.pendingPollTimeoutMs,
  });
  const asyncSender = config.asyncReplyProvider === "customer_service"
    ? new WechatCustomerServiceSender(
        config.wechatApiBaseUrl,
        new WechatAccessTokenProvider({
          apiBaseUrl: config.wechatApiBaseUrl,
          appId: config.appId,
          appSecret: config.appSecret,
        }),
      )
    : null;
  const delivery = new MessageDeliveryCoordinator(gateway, {
    asyncSender,
    logger: safeLogger,
    syncTimeoutMs: config.syncTimeoutMs,
  });
  const app = createWechatApp(config, { delivery, logger: safeLogger });
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
  safeLogger.info("wechat_adapter_started", {
    host: config.host,
    mode: config.messageMode,
    port: config.port,
    provider: config.asyncReplyProvider,
  });
  const shutdown = (): void => {
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (process.env.NODE_ENV !== "test") {
  try {
    startWechatAdapter();
  } catch {
    safeLogger.error("wechat_adapter_start_failed");
    process.exitCode = 1;
  }
}

export { createWechatApp } from "./app.js";
