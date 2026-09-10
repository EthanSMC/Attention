/** Recognize a refusal, never an allowlist for fetching a credential-bearing URL. */
export function isWechatVerificationRedirect(from: URL, target: URL): boolean {
  return from.protocol === "https:" && from.hostname === "mp.weixin.qq.com"
    && target.origin === from.origin
    && !target.username && !target.password && !target.hash
    && target.pathname === "/mp/wappoc_appmsgcaptcha"
    && [...target.searchParams.keys()].every(key => key === "poc_token" || key === "target_url")
    && target.searchParams.getAll("poc_token").length === 1
    && target.searchParams.getAll("target_url").length === 1;
}
