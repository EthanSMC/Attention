import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { isPublicAddress, isUnsafeHostname } from "../../fetcher/src/ip-policy.js";
import { BrowserTaskError } from "./contracts.js";

/** Fixed source adapter policy; never expanded by HTML, an LLM, or tool input. */
const WECHAT_ASSETS = ["res.wx.qq.com", "mmbiz.qpic.cn", "mmbiz.qlogo.cn", "wxsnsdy.wxs.qq.com"];
export function sourcePolicy(source: string) {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    isUnsafeHostname(url.hostname) || isIP(url.hostname) || url.hash) throw new BrowserTaskError("unsafe_source");
  const hosts = new Set([url.hostname]);
  if (url.hostname === "mp.weixin.qq.com") WECHAT_ASSETS.forEach(host => hosts.add(host));
  return { source: url.toString(), origin: url.origin, hosts };
}
export function allowedResource(raw: string, source: string, document: boolean): boolean {
  try {
    const policy = sourcePolicy(source), url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !policy.hosts.has(url.hostname)) return false;
    if (!document) return true;
    url.hash = "";
    if (url.toString() === policy.source) return true;
    // Human-operated challenge only; never evidence or another article.
    if (url.origin !== policy.origin || url.hostname !== "mp.weixin.qq.com" || url.pathname !== "/mp/wappoc_appmsgcaptcha") return false;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes("poc_token") || !keys.includes("target_url")) return false;
    return url.searchParams.get("target_url") === policy.source && Boolean(url.searchParams.get("poc_token"));
  } catch { return false; }
}

export async function resolvePublicTarget(host: string, allowedHosts: ReadonlySet<string>,
  resolver = (name: string) => lookup(name, { all: true, verbatim: true })) {
  if (!allowedHosts.has(host) || isUnsafeHostname(host) || isIP(host)) throw new BrowserTaskError("unsafe_source");
  const addresses = await resolver(host);
  if (!addresses.length || addresses.length > 32 || addresses.some(entry => !isPublicAddress(entry.address))) throw new BrowserTaskError("unsafe_source");
  return addresses[0]!;
}
