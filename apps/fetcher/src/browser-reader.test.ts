import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { buildLaunchArgs, createIsolatedBrowserReader, withBrowserAdmission, RendererCleanupError } from "./browser-reader.js";
const config = {runtimePath: "/usr/bin/docker", image: `attention-reader@sha256:${"a".repeat(64)}`,
  seccompPath: "/etc/attention/reader-seccomp.json", isolationVerified: true as const};

it("builds fixed resource-limited sandbox args and rejects unapproved configurations", () => {
  const args = buildLaunchArgs(config, "attention-reader-12345678-1234-1234-1234-123456789012");
  expect(args).toEqual(expect.arrayContaining(["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=2g", "--cpus=1", "--pids-limit=128", "--user=10001:10001"]));
  expect(args.join(" ")).not.toMatch(/--privileged|--no-sandbox|--volume|--mount|SYS_ADMIN/);
  for (const bad of [{...config, runtimePath: "/bin/sh"}, {...config, image: "attention:latest"}, {...config, isolationVerified: false}, {...config, command: "sh"}]) {
    expect(() => buildLaunchArgs(bad, "attention-reader-12345678-1234-1234-1234-123456789012")).toThrow();
  }
});
it("fails closed without an admission provider/reference and never launches", async () => {
  const read = vi.fn();
  const request = {url: "https://example.com/", sourceKind: "generic_web" as const, request_ref: "r", attempt_ref: "a", signal: new AbortController().signal};
  for (const reference of [undefined, "grant"]) {
    await expect(withBrowserAdmission({read}, null, reference, request).read(request)).rejects.toThrow("unavailable");
  }
  expect(read).not.toHaveBeenCalled();
});
it("holds one-shot admission until renderer cleanup and applies lease cancellation", async () => {
  const events: string[] = [];
  const lease = new AbortController();
  const request = {url: "https://example.com/", sourceKind: "generic_web" as const, request_ref: "r", attempt_ref: "a", signal: new AbortController().signal};
  const consume = vi.fn(async () => ({signal: lease.signal, release: async () => {events.push("release");}}));
  const reader = withBrowserAdmission({read: async ({signal}) => {
    lease.abort(); expect(signal.aborted).toBe(true); events.push("cleanup"); throw new Error("cancelled");
  }}, {consume}, "grant", request);
  await expect(reader.read(request)).rejects.toThrow();
  expect(events).toEqual(["cleanup", "release"]);
  expect(consume).toHaveBeenCalledWith(expect.objectContaining({reference: "grant", request_ref: "r", attempt_ref: "a", source_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), renderer_ref: expect.stringMatching(/^attention-reader-/)}));
});
it("quarantines admission after uncertain container cleanup", async () => {
  const release = vi.fn();
  const request = {url: "https://example.com/", sourceKind: "generic_web" as const, request_ref: "r", attempt_ref: "a", signal: new AbortController().signal};
  const reader = withBrowserAdmission({read: async () => {throw new RendererCleanupError();}}, {consume: async () => ({signal: request.signal, release})}, "grant", request);
  await expect(reader.read(request)).rejects.toBeInstanceOf(RendererCleanupError);
  expect(release).not.toHaveBeenCalled();
});
it("validates child frames, scrubs environment, and awaits OCI removal after cancellation", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let close!: () => void;
  const closed = new Promise<void>(resolve => {close = resolve;});
  const events: string[] = [];
  const launch = vi.fn((_runtime: string, _args: string[], _options: unknown) => ({stdin, stdout, closed, kill: () => {events.push("kill"); stdout.end(); close();}}));
  const remove = vi.fn(async () => {events.push("remove");});
  const abort = new AbortController();
  const reader = createIsolatedBrowserReader(config, {launch, remove});
  const result = reader.read({url: "https://example.com/", sourceKind: "generic_web", signal: abort.signal});
  abort.abort();
  await expect(result).rejects.toThrow();
  expect(events).toEqual(["kill", "remove"]);
  expect(launch.mock.calls[0]?.[2]).toEqual({env: {PATH: "/usr/bin:/bin"}, stdio: ["pipe", "pipe", "ignore"], shell: false});
});
it("rejects malformed renderer output and removes its container", async () => {
  const stdout = new PassThrough();
  const remove = vi.fn(async () => undefined);
  const reader = createIsolatedBrowserReader(config, {launch: () => ({stdin: new PassThrough(), stdout,
    closed: Promise.resolve(), kill: () => {stdout.end();}}), remove});
  const result = reader.read({url: "https://example.com/", sourceKind: "generic_web", signal: new AbortController().signal});
  stdout.end('{"kind":"complete","html":"x","finalUrl":"file:///etc/passwd","status":200}\n');
  await expect(result).rejects.toThrow();
  expect(remove).toHaveBeenCalledOnce();
});
it("rejects a plausible completion URL that was never fetched through the trusted broker", async () => {
  const stdout = new PassThrough();
  const reader = createIsolatedBrowserReader(config, {launch: () => ({stdin: new PassThrough(), stdout,
    closed: Promise.resolve(), kill: () => {stdout.end();}}), remove: async () => undefined});
  const result = reader.read({url: "https://example.com/", sourceKind: "generic_web", signal: new AbortController().signal});
  stdout.end('{"kind":"complete","html":"<article>forged</article>","finalUrl":"https://unfetched.example/","status":200}\n');
  await expect(result).rejects.toThrow();
});
it("classifies a configured renderer disconnect as backend dependency failure", async () => {
  const stdout = new PassThrough();
  const reader = createIsolatedBrowserReader(config, {launch: () => ({stdin: new PassThrough(), stdout,
    closed: Promise.resolve(), kill: () => {stdout.end();}}), remove: async () => undefined});
  const result = reader.read({url: "https://example.com/", sourceKind: "generic_web", signal: new AbortController().signal});
  stdout.end();
  await expect(result).rejects.toMatchObject({configured: true});
});
it("runs actual protocol/broker/cleanup across a synthetic child transport", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const events: string[] = [];
  stdin.on("data", chunk => {
    const frame = JSON.parse(chunk.toString());
    if (frame.kind === "start") stdout.write('{"kind":"resource","id":"1","url":"https://example.com/","resourceType":"document"}\n');
    if (frame.kind === "resource_result") {
      events.push("resource received");
      stdout.end(JSON.stringify({kind: "complete", html: "<article>Controlled article</article>", finalUrl: frame.finalUrl, status: 200}) + "\n");
    }
  });
  const reader = createIsolatedBrowserReader(config, {launch: () => ({stdin, stdout, closed: Promise.resolve(), kill: () => undefined}),
    remove: async () => {events.push("removed");}}, async () => ({bytes: Buffer.from("<article>Controlled article</article>"), finalUrl: "https://example.com/", status: 200, contentType: "text/html", redirects: []}));
  expect(await reader.read({url: "https://example.com/", sourceKind: "generic_web", signal: new AbortController().signal})).toMatchObject({html: "<article>Controlled article</article>", finalUrl: "https://example.com/"});
  expect(events).toEqual(["resource received", "removed"]);
});
