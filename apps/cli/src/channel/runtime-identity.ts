import { createHash } from "node:crypto";

export function opaqueRuntimeFingerprint(
  namespace: string,
  value: string,
): string {
  return createHash("sha256")
    .update(`attention:${namespace}:`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function channelSessionFingerprint(token: string): string {
  if (!token) throw new Error("ilink_session_missing");
  return opaqueRuntimeFingerprint("wechat_ilink_session", token);
}
