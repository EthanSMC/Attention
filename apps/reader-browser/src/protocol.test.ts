import { expect, it } from "vitest";
import { FrameDecoder, encodeFrame, WireBudget } from "./protocol.js";

it("decodes split JSONL while rejecting malformed/unknown/credential fields", () => {
  const decoder = new FrameDecoder(new WireBudget());
  expect(decoder.push(Buffer.from('{"kind":"resource","id":"1","url":"https://example.com/a",'))).toEqual([]);
  expect(decoder.push(Buffer.from('"resourceType":"script"}\n'))).toEqual([
    {kind: "resource", id: "1", url: "https://example.com/a", resourceType: "script"}]);
  for (const frame of ['{broken}\n', '{"kind":"failed","code":"secret error"}\n',
    '{"kind":"resource","id":"1","url":"https://example.com","resourceType":"script","cookie":"secret"}\n']) {
    expect(() => new FrameDecoder(new WireBudget()).push(Buffer.from(frame))).toThrow();
  }
});
it("bounds incomplete frames, aggregate wire bytes, snapshot UTF8 and binary encodings", () => {
  expect(() => new FrameDecoder(new WireBudget()).push(Buffer.alloc(3 * 1024 * 1024 + 1, 65))).toThrow();
  const budget = new WireBudget();
  budget.charge(20 * 1024 * 1024);
  expect(() => budget.charge(1)).toThrow();
  expect(() => encodeFrame({kind: "complete", html: "中".repeat(700_000), finalUrl: "https://example.com/", status: 200}, new WireBudget())).toThrow();
  expect(() => encodeFrame({kind: "resource_result", id: "1", bodyBase64: "***", status: 200, contentType: "text/html", finalUrl: "https://example.com/"}, new WireBudget())).toThrow();
});
it("requires bounded final URL for redirected resources and rejects extra commands", () => {
  const frame = {kind: "resource_result", id: "1", bodyBase64: "", status: 200, contentType: "text/css", finalUrl: "https://cdn.example.com/css/main.css"};
  expect(new FrameDecoder(new WireBudget()).push(encodeFrame(frame, new WireBudget()))).toEqual([frame]);
  expect(() => encodeFrame({...frame, command: "sh"}, new WireBudget())).toThrow();
});
