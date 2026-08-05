import { createHash, timingSafeEqual } from "node:crypto";

export type SignatureFailureCode =
  | "invalid_nonce"
  | "invalid_signature"
  | "invalid_timestamp"
  | "stale_timestamp";

export class SignatureError extends Error {
  constructor(readonly code: SignatureFailureCode) {
    super(code);
    this.name = "SignatureError";
  }
}

export function wechatSignature(values: readonly string[]): string {
  return createHash("sha1").update([...values].sort().join(""), "utf8").digest("hex");
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{40}$/iu.test(actual) || !/^[a-f0-9]{40}$/iu.test(expected)) return false;
  const actualBytes = Buffer.from(actual.toLowerCase(), "ascii");
  const expectedBytes = Buffer.from(expected.toLowerCase(), "ascii");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function validateWechatTimestamp(
  timestamp: string,
  nonce: string,
  options: { maxSkewSeconds: number; now?: Date },
): void {
  if (!/^\d{1,12}$/u.test(timestamp)) throw new SignatureError("invalid_timestamp");
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(nonce)) throw new SignatureError("invalid_nonce");
  const seconds = Number(timestamp);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(seconds)) throw new SignatureError("invalid_timestamp");
  if (Math.abs(nowSeconds - seconds) > options.maxSkewSeconds) {
    throw new SignatureError("stale_timestamp");
  }
}

export function verifyPlaintextSignature(input: {
  maxSkewSeconds: number;
  nonce: string;
  now?: Date;
  signature: string;
  timestamp: string;
  token: string;
}): void {
  validateWechatTimestamp(input.timestamp, input.nonce, input);
  const expected = wechatSignature([input.token, input.timestamp, input.nonce]);
  if (!safeEqualHex(input.signature, expected)) throw new SignatureError("invalid_signature");
}

export function verifyEncryptedSignature(input: {
  encrypted: string;
  maxSkewSeconds: number;
  nonce: string;
  now?: Date;
  signature: string;
  timestamp: string;
  token: string;
}): void {
  validateWechatTimestamp(input.timestamp, input.nonce, input);
  const expected = wechatSignature([
    input.token,
    input.timestamp,
    input.nonce,
    input.encrypted,
  ]);
  if (!safeEqualHex(input.signature, expected)) throw new SignatureError("invalid_signature");
}
