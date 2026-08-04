import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { wechatSignature } from "./signature.js";
import { serializeWechatXml } from "./xml.js";

const BLOCK_SIZE = 32;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class WechatCryptoError extends Error {
  constructor(readonly code: "app_id_mismatch" | "invalid_ciphertext" | "invalid_padding") {
    super(code);
    this.name = "WechatCryptoError";
  }
}

function decodeKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new WechatCryptoError("invalid_ciphertext");
  return key;
}

function pad(value: Buffer): Buffer {
  let amount = BLOCK_SIZE - (value.length % BLOCK_SIZE);
  if (amount === 0) amount = BLOCK_SIZE;
  return Buffer.concat([value, Buffer.alloc(amount, amount)]);
}

function unpad(value: Buffer): Buffer {
  const amount = value.at(-1) ?? 0;
  if (amount < 1 || amount > BLOCK_SIZE || amount > value.length) {
    throw new WechatCryptoError("invalid_padding");
  }
  const padding = value.subarray(value.length - amount);
  if (padding.some((byte) => byte !== amount)) throw new WechatCryptoError("invalid_padding");
  return value.subarray(0, value.length - amount);
}

function strictBase64(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new WechatCryptoError("invalid_ciphertext");
  }
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value) {
    throw new WechatCryptoError("invalid_ciphertext");
  }
  return decoded;
}

export function decryptWechatMessage(input: {
  appId: string;
  ciphertext: string;
  encodingAesKey: string;
}): string {
  const key = decodeKey(input.encodingAesKey);
  let padded: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    padded = Buffer.concat([
      decipher.update(strictBase64(input.ciphertext)),
      decipher.final(),
    ]);
  } catch (error) {
    if (error instanceof WechatCryptoError) throw error;
    throw new WechatCryptoError("invalid_ciphertext");
  }
  const clear = unpad(padded);
  if (clear.length < 20) throw new WechatCryptoError("invalid_ciphertext");
  const messageLength = clear.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > clear.length) throw new WechatCryptoError("invalid_ciphertext");
  let message: string;
  let appId: string;
  try {
    message = utf8Decoder.decode(clear.subarray(20, messageEnd));
    appId = utf8Decoder.decode(clear.subarray(messageEnd));
  } catch {
    throw new WechatCryptoError("invalid_ciphertext");
  }
  if (appId !== input.appId) throw new WechatCryptoError("app_id_mismatch");
  return message;
}

export function encryptWechatMessage(input: {
  appId: string;
  encodingAesKey: string;
  message: string;
  randomBytesImplementation?: (size: number) => Buffer;
}): string {
  const key = decodeKey(input.encodingAesKey);
  const message = Buffer.from(input.message, "utf8");
  const appId = Buffer.from(input.appId, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const random = (input.randomBytesImplementation ?? randomBytes)(16);
  if (random.length !== 16) throw new WechatCryptoError("invalid_ciphertext");
  const clear = pad(Buffer.concat([random, length, message, appId]));
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(clear), cipher.final()]).toString("base64");
}

export function encryptedReplyXml(input: {
  appId: string;
  encodingAesKey: string;
  message: string;
  nonce: string;
  timestamp: number;
  token: string;
}): string {
  const encrypted = encryptWechatMessage(input);
  const signature = wechatSignature([
    input.token,
    String(input.timestamp),
    input.nonce,
    encrypted,
  ]);
  return serializeWechatXml({
    Encrypt: encrypted,
    MsgSignature: signature,
    Nonce: input.nonce,
    TimeStamp: input.timestamp,
  });
}
