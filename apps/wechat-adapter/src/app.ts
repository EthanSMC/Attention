import { Hono } from "hono";

import type { DeliveryOutcome } from "./delivery.js";
import { decryptWechatMessage, encryptedReplyXml, WechatCryptoError } from "./message-crypto.js";
import { normalizeWechatMessage, WechatMessageError } from "./message-mapper.js";
import { passiveTextReply } from "./passive-reply.js";
import {
  SignatureError,
  verifyEncryptedSignature,
  verifyPlaintextSignature,
} from "./signature.js";
import type { NormalizedWechatMessage, SafeLogger, WechatAdapterConfig } from "./types.js";
import { parseWechatXml, WechatXmlError } from "./xml.js";

interface MessageDelivery {
  deliver(message: NormalizedWechatMessage): Promise<DeliveryOutcome>;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

export interface WechatAppDependencies {
  delivery: MessageDelivery;
  logger: SafeLogger;
  now?: () => Date;
}

function queryValue(value: string | undefined): string {
  return value ?? "";
}

function encryptedRequest(encryptType: string, messageSignature: string): boolean {
  return encryptType === "aes" || Boolean(messageSignature);
}

function modeAllowed(config: WechatAdapterConfig, encrypted: boolean): boolean {
  if (config.messageMode === "safe") return encrypted;
  if (config.messageMode === "plaintext") return !encrypted;
  return true;
}

function xmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "application/xml; charset=utf-8" },
    status: 200,
  });
}

function stableError(status: number, code: string): Response {
  return new Response(code, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status,
  });
}

function contentTypeAllowed(value: string | null): boolean {
  if (!value) return true;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "text/xml" || mime === "application/xml";
}

async function readUtf8BodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("payload_too_large").catch(() => undefined);
        throw new PayloadTooLargeError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function responseForError(error: unknown): Response {
  if (error instanceof PayloadTooLargeError) {
    return stableError(413, "payload_too_large");
  }
  if (error instanceof SignatureError) return stableError(403, "invalid_signature");
  if (error instanceof WechatXmlError || error instanceof WechatCryptoError) {
    return stableError(400, "invalid_message");
  }
  if (error instanceof WechatMessageError) {
    return error.code === "unsupported_message"
      ? stableError(200, "success")
      : stableError(422, "invalid_message");
  }
  return stableError(500, "internal_error");
}

export function createWechatApp(
  config: WechatAdapterConfig,
  dependencies: WechatAppDependencies,
): Hono {
  const app = new Hono();
  const now = dependencies.now ?? (() => new Date());

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  app.get(config.callbackPath, (context) => {
    try {
      const timestamp = queryValue(context.req.query("timestamp"));
      const nonce = queryValue(context.req.query("nonce"));
      const messageSignature = queryValue(context.req.query("msg_signature"));
      const encryptType = queryValue(context.req.query("encrypt_type"));
      const encrypted = encryptedRequest(encryptType, messageSignature);
      if (!modeAllowed(config, encrypted)) throw new SignatureError("invalid_signature");
      const echo = queryValue(context.req.query("echostr"));
      if (!echo || echo.length > 8_192) return stableError(400, "invalid_request");
      if (encrypted) {
        if (encryptType && encryptType !== "aes") throw new SignatureError("invalid_signature");
        verifyEncryptedSignature({
          encrypted: echo,
          maxSkewSeconds: config.maxTimestampSkewSeconds,
          nonce,
          now: now(),
          signature: messageSignature,
          timestamp,
          token: config.callbackToken,
        });
        const clearEcho = decryptWechatMessage({
          appId: config.appId,
          ciphertext: echo,
          encodingAesKey: config.encodingAesKey,
        });
        return new Response(clearEcho, {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
        });
      }
      verifyPlaintextSignature({
        maxSkewSeconds: config.maxTimestampSkewSeconds,
        nonce,
        now: now(),
        signature: queryValue(context.req.query("signature")),
        timestamp,
        token: config.callbackToken,
      });
      return new Response(echo, {
        headers: { "content-type": "text/plain; charset=utf-8" },
        status: 200,
      });
    } catch (error) {
      return responseForError(error);
    }
  });

  app.post(config.callbackPath, async (context) => {
    try {
      if (!contentTypeAllowed(context.req.header("content-type") ?? null)) {
        return stableError(415, "unsupported_media_type");
      }
      const lengthValue = context.req.header("content-length");
      if (lengthValue && (/^\d+$/u.test(lengthValue) === false || Number(lengthValue) > config.maxBodyBytes)) {
        return stableError(413, "payload_too_large");
      }
      const timestamp = queryValue(context.req.query("timestamp"));
      const nonce = queryValue(context.req.query("nonce"));
      const messageSignature = queryValue(context.req.query("msg_signature"));
      const encryptType = queryValue(context.req.query("encrypt_type"));
      const encrypted = encryptedRequest(encryptType, messageSignature);
      if (!modeAllowed(config, encrypted)) throw new SignatureError("invalid_signature");
      if (encrypted && encryptType && encryptType !== "aes") {
        throw new SignatureError("invalid_signature");
      }
      const body = await readUtf8BodyWithinLimit(
        context.req.raw,
        config.maxBodyBytes,
      );

      let messageXml: string;
      if (encrypted) {
        const outer = parseWechatXml(body);
        const ciphertext = outer.Encrypt ?? "";
        verifyEncryptedSignature({
          encrypted: ciphertext,
          maxSkewSeconds: config.maxTimestampSkewSeconds,
          nonce,
          now: now(),
          signature: messageSignature,
          timestamp,
          token: config.callbackToken,
        });
        messageXml = decryptWechatMessage({
          appId: config.appId,
          ciphertext,
          encodingAesKey: config.encodingAesKey,
        });
      } else {
        verifyPlaintextSignature({
          maxSkewSeconds: config.maxTimestampSkewSeconds,
          nonce,
          now: now(),
          signature: queryValue(context.req.query("signature")),
          timestamp,
          token: config.callbackToken,
        });
        messageXml = body;
      }

      const message = normalizeWechatMessage({
        appId: config.appId,
        fields: parseWechatXml(messageXml),
        hmacSecret: config.attentionApiSecret,
        originalId: config.originalId,
      });
      const outcome = await dependencies.delivery.deliver(message);
      const reply = passiveTextReply({
        createTime: Math.floor(now().getTime() / 1_000),
        fromUser: message.toUser,
        text: outcome.text,
        toUser: message.fromUser,
      });
      if (!encrypted) return xmlResponse(reply);
      return xmlResponse(encryptedReplyXml({
        appId: config.appId,
        encodingAesKey: config.encodingAesKey,
        message: reply,
        nonce,
        timestamp: Math.floor(now().getTime() / 1_000),
        token: config.callbackToken,
      }));
    } catch (error) {
      const response = responseForError(error);
      if (response.status >= 500) dependencies.logger.error("wechat_callback_failed");
      return response;
    }
  });

  app.onError((_error) => {
    dependencies.logger.error("wechat_adapter_unhandled_error");
    return stableError(500, "internal_error");
  });
  app.notFound((context) => context.text("not_found", 404));
  return app;
}
