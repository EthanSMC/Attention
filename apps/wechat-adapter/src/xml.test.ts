import { describe, expect, it } from "vitest";

import { parseWechatXml, serializeWechatXml, WechatXmlError } from "./xml.js";

describe("WeChat XML", () => {
  it("parses flat CDATA and supported XML entities", () => {
    expect(parseWechatXml(
      "<xml><Content><![CDATA[a<&b]]></Content><Title>A &amp; B</Title></xml>",
    )).toEqual({ Content: "a<&b", Title: "A & B" });
  });

  it("round-trips values including a CDATA terminator", () => {
    const xml = serializeWechatXml({ Content: "left]]>right", Count: 2 });
    expect(parseWechatXml(xml)).toEqual({ Content: "left]]>right", Count: "2" });
  });

  it.each([
    "<!DOCTYPE xml [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><xml><A>&xxe;</A></xml>",
    "<xml><A><B>nested</B></A></xml>",
    "<xml><A>one</A><A>two</A></xml>",
    "<xml><A>&unknown;</A></xml>",
  ])("rejects unsafe, nested, duplicate or ambiguous XML", (xml) => {
    expect(() => parseWechatXml(xml)).toThrow(WechatXmlError);
  });
});
