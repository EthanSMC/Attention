import { describe, expect, it } from "vitest";
import { allowedResource, resolvePublicTarget, sourcePolicy } from "./network-policy";

const source = "https://mp.weixin.qq.com/s/example";
describe("dedicated browser network policy", () => {
  it.each(["http://mp.weixin.qq.com/s/x", "https://localhost/x", "https://127.0.0.1/x",
    "https://user:password@mp.weixin.qq.com/s/x", "https://mp.weixin.qq.com:3000/s/x", "file:///tmp/x"])("rejects unsafe source %s", url => {
    expect(() => sourcePolicy(url)).toThrow();
  });
  it("only permits the approved article or its exact bounded human challenge", () => {
    expect(allowedResource(source, source, true)).toBe(true);
    expect(allowedResource(source + "different", source, true)).toBe(false);
    const challenge = "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=opaque&target_url=" + encodeURIComponent(source);
    expect(allowedResource(challenge, source, true)).toBe(true);
    expect(allowedResource(challenge + "&target_url=https://evil.example", source, true)).toBe(false);
    expect(allowedResource(challenge.replace("mp.weixin.qq.com/mp/", "evil.example/mp/"), source, true)).toBe(false);
    expect(allowedResource(challenge.replace(encodeURIComponent(source), encodeURIComponent("https://other.example")), source, true)).toBe(false);
  });
  it("allows only explicitly declared asset hosts and HTTPS", () => {
    expect(allowedResource("https://res.wx.qq.com/a.js", source, false)).toBe(true);
    expect(allowedResource("https://res.wx.qq.com/a.js", source, true)).toBe(false);
    expect(allowedResource("https://res.wx.qq.com.evil.example/a", source, false)).toBe(false);
    expect(allowedResource("http://res.wx.qq.com/a", source, false)).toBe(false);
    expect(allowedResource("https://127.0.0.1/admin", source, false)).toBe(false);
  });
  it.each(["127.0.0.1", "10.0.0.1", "::1", "169.254.169.254", "192.168.1.1", "::ffff:127.0.0.1"])("rejects private DNS result %s", address => {
    return expect(resolvePublicTarget("mp.weixin.qq.com", sourcePolicy(source).hosts,
      async () => [{ address, family: address.includes(":") ? 6 : 4 }])).rejects.toThrow();
  });
  it("rejects mixed public/private answers instead of selecting the public answer", async () => {
    await expect(resolvePublicTarget("mp.weixin.qq.com", sourcePolicy(source).hosts,
      async () => [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }])).rejects.toThrow();
  });
  it("returns a concrete validated address for connection pinning", async () => {
    expect(await resolvePublicTarget("mp.weixin.qq.com", sourcePolicy(source).hosts,
      async () => [{ address: "1.1.1.1", family: 4 }])).toEqual({ address: "1.1.1.1", family: 4 });
  });
});
