import { expect, it, vi } from "vitest";
import { ResourceBroker } from "./renderer-resource.js";
const frame = {kind: "resource" as const, id: "1", url: "https://example.com/app.js", resourceType: "script" as const};
const signal = new AbortController().signal;
const response = {bytes: new Uint8Array([1]), status: 200, contentType: "application/javascript", finalUrl: frame.url, redirects: []};

it("rejects private resources and secret-bearing query URLs before IO", async () => {
  const read = vi.fn(async () => response);
  const broker = new ResourceBroker("generic_web", signal, read);
  for (const [index, url] of ["http://127.0.0.1/", "https://example.com/a?access_token=secret"].entries()) {
    await expect(broker.read({...frame, id: String(index + 1), url})).rejects.toThrow();
  }
  expect(read).not.toHaveBeenCalled();
});
it("rejects duplicate IDs and more than 100 resources", async () => {
  const broker = new ResourceBroker("generic_web", signal, async () => response);
  expect(await broker.read(frame)).toMatchObject({bodyBase64: "AQ==", finalUrl: frame.url});
  await expect(broker.read(frame)).rejects.toThrow();
  for (let i = 2; i <= 100; i++) await broker.read({...frame, id: String(i)});
  await expect(broker.read({...frame, id: "101"})).rejects.toThrow();
});
it("caps concurrency at four and waits for cancellation cleanup", async () => {
  const abort = new AbortController();
  let active = 0;
  const broker = new ResourceBroker("generic_web", abort.signal, async (_url, _kind, options) => {
    active++;
    await new Promise<void>(resolve => options!.signal!.addEventListener("abort", () => {active--; resolve();}, {once: true}));
    throw new Error("cancelled");
  });
  const reads = Array.from({length: 4}, (_, i) => broker.read({...frame, id: String(i + 1)}));
  expect(active).toBe(4);
  await expect(broker.read({...frame, id: "5"})).rejects.toThrow();
  abort.abort();
  await Promise.allSettled(reads);
  await broker.close();
  expect(active).toBe(0);
});
it("charges cumulative binary bytes and rejects unsafe final redirects", async () => {
  const broker = new ResourceBroker("generic_web", signal, async () => ({...response, bytes: new Uint8Array(2 * 1024 * 1024)}));
  for (let i = 1; i <= 10; i++) await broker.read({...frame, id: String(i)});
  await expect(broker.read({...frame, id: "11"})).rejects.toThrow();
  const bad = new ResourceBroker("generic_web", signal, async () => ({...response, finalUrl: "http://169.254.169.254/"}));
  await expect(bad.read(frame)).rejects.toThrow();
});
it("reserves the shared remaining byte budget before parallel resource reads", async () => {
  let finish: (() => void) | undefined;
  let count = 0;
  const broker = new ResourceBroker("generic_web", signal, async () => {
    count++;
    if (count === 10) await new Promise<void>(resolve => {finish = resolve;});
    return {...response, bytes: new Uint8Array(2 * 1024 * 1024)};
  });
  for (let i = 1; i <= 9; i++) await broker.read({...frame, id: String(i)});
  const last = broker.read({...frame, id: "10"});
  await expect(broker.read({...frame, id: "11"})).rejects.toThrow();
  finish?.(); await last;
  expect(count).toBe(10);
});
