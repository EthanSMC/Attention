const forbiddenXml = /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/iu;
const fieldPattern = /<([A-Za-z][A-Za-z0-9_]*)>([\s\S]*?)<\/\1>/gu;
const fieldValuePattern = /<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/gu;

export class WechatXmlError extends Error {
  constructor(readonly code: "duplicate_xml_field" | "invalid_xml" | "unsafe_xml") {
    super(code);
    this.name = "WechatXmlError";
  }
}

function decodeXml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  let invalid = false;
  const decoded = value.replace(/&([^;\s]{1,24});/gu, (entity, token: string) => {
    if (!/^(?:#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot)$/iu.test(token)) {
      invalid = true;
      return entity;
    }
    if (token.startsWith("#")) {
      const hex = token[1]?.toLowerCase() === "x";
      const point = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(point) && point >= 0 && point <= 0x10ffff &&
        (point < 0xd800 || point > 0xdfff)) {
        return String.fromCodePoint(point);
      }
      invalid = true;
      return entity;
    }
    return named[token.toLowerCase()] ?? entity;
  });
  if (invalid || /&(?!#x[0-9a-f]+;|#\d+;|amp;|apos;|gt;|lt;|quot;)/iu.test(value)) {
    throw new WechatXmlError("invalid_xml");
  }
  return decoded;
}

function decodeFieldValue(value: string): string {
  if (!value) return "";
  let cursor = 0;
  let decoded = "";
  for (const match of value.matchAll(fieldValuePattern)) {
    if (match.index === undefined || match.index !== cursor) throw new WechatXmlError("invalid_xml");
    decoded += match[1] ?? decodeXml(match[2] ?? "");
    cursor = match.index + match[0].length;
  }
  if (cursor !== value.length) throw new WechatXmlError("invalid_xml");
  return decoded;
}

export function parseWechatXml(xml: string): Record<string, string> {
  if (!xml || forbiddenXml.test(xml) || xml.includes("\0")) {
    throw new WechatXmlError("unsafe_xml");
  }
  const normalized = xml.replace(/^\s*<\?xml\s+version=["']1\.0["']\s*\?>\s*/iu, "").trim();
  const root = /^<xml>\s*([\s\S]*?)\s*<\/xml>$/u.exec(normalized);
  if (!root?.[1]) throw new WechatXmlError("invalid_xml");
  const inner = root[1];
  const fields: Record<string, string> = {};
  let cursor = 0;
  let count = 0;
  for (const match of inner.matchAll(fieldPattern)) {
    if (match.index === undefined || inner.slice(cursor, match.index).trim()) {
      throw new WechatXmlError("invalid_xml");
    }
    const name = match[1];
    if (!name) throw new WechatXmlError("invalid_xml");
    if (Object.hasOwn(fields, name)) throw new WechatXmlError("duplicate_xml_field");
    const value = decodeFieldValue(match[2] ?? "");
    if (value.length > 32_768) throw new WechatXmlError("invalid_xml");
    fields[name] = value;
    cursor = match.index + match[0].length;
    count += 1;
    if (count > 64) throw new WechatXmlError("invalid_xml");
  }
  if (count === 0 || inner.slice(cursor).trim()) throw new WechatXmlError("invalid_xml");
  return fields;
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function serializeWechatXml(fields: Record<string, number | string>): string {
  const body = Object.entries(fields).map(([name, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name)) throw new WechatXmlError("invalid_xml");
    return typeof value === "number"
      ? `<${name}>${value}</${name}>`
      : `<${name}>${cdata(value)}</${name}>`;
  }).join("");
  return `<xml>${body}</xml>`;
}
