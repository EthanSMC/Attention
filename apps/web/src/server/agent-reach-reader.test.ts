import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadRequest } from "@attention/content-reader-contracts";
import { AgentReachProcessError } from "./agent-reach-process";
import { readAgentReachSource, readConfiguredCollectionSource } from "./agent-reach-reader";
import { readExternalSource } from "./fetcher-client";

vi.mock("./fetcher-client", () => ({readExternalSource: vi.fn()}));
const image = `attention/agent-reach@sha256:${"a".repeat(64)}`;
const request: ReadRequest = {request_ref: "req-1", attempt_ref: "attempt-1", sourceKind: "generic_web", url: "https://example.com/article"};
const options = () => ({signal: new AbortController().signal, admissionReference: "private-admission-never-forward"});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("Agent-Reach collection reader selection", () => {
  it("keeps the original reader unchanged when not configured", async () => {
    vi.stubEnv("ATTENTION_AGENT_REACH_IMAGE", "");
    vi.mocked(readExternalSource).mockResolvedValue({schema_version: 1, request_ref: "req-1", attempt_ref: "attempt-1", attempts: [], outcome: "skipped", reason: "not_eligible"});
    const opts = options(); await readConfiguredCollectionSource(request, opts);
    expect(readExternalSource).toHaveBeenCalledWith(request, opts);
  });
  it("fails closed on invalid configuration instead of silently switching readers", async () => {
    vi.stubEnv("ATTENTION_AGENT_REACH_IMAGE", "image:latest");
    expect(await readConfiguredCollectionSource(request, options())).toMatchObject({code: "reader_not_configured", attempts: []});
    expect(readExternalSource).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1/", "http://service.internal/", "https://user:secret@example.com/", "https://example.com/?api_key=secret"])("rejects unsafe input %s before process execution", async url => {
    const run = vi.fn();
    // Userinfo is excluded already by the public ReadRequest contract.
    if (url.includes("user:")) await expect(readAgentReachSource({...request, url}, options(), image, run)).rejects.toThrow();
    else expect(await readAgentReachSource({...request, url}, options(), image, run)).toMatchObject({code: "unsafe_source", attempts: []});
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["https://www.xiaohongshu.com/explore/123456", "https://xhslink.com/abc"])("does not send Xiaohongshu to the public provider even if mislabeled: %s", async url => {
    const run = vi.fn();
    expect(await readAgentReachSource({...request, url}, options(), image, run)).toMatchObject({code: "reader_not_configured", attempts: []});
    expect(run).not.toHaveBeenCalled();
  });
  it("sends only the normalized source and correlated references, and maps stable process failure", async () => {
    const run = vi.fn().mockRejectedValue(new AgentReachProcessError("network_timeout"));
    expect(await readAgentReachSource({...request, url: `${request.url}#section`}, options(), image, run))
      .toMatchObject({code: "network_timeout", attempts: [{method: "agent_reach"}]});
    const input = JSON.parse(run.mock.calls[0]![0] as string);
    expect(input).toEqual({schema_version: 1, request_ref: "req-1", attempt_ref: "attempt-1", source_kind: "generic_web", url: request.url});
    expect(JSON.stringify(run.mock.calls)).not.toContain("private-admission");
  });
  it("discards results after authorization cancellation", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => { controller.abort(); return {}; });
    await expect(readAgentReachSource(request, {...options(), signal: controller.signal}, image, run)).rejects.toThrow();
  });
  it("records only a fixed cleanup failure event even when cancellation supersedes the result", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const run = vi.fn(async () => { controller.abort(); throw new AgentReachProcessError("unknown_reader_error", true); });
    await expect(readAgentReachSource(request, {...options(), signal: controller.signal}, image, run)).rejects.toThrow();
    expect(log).toHaveBeenCalledExactlyOnceWith("attention_agent_reach_cleanup_unconfirmed");
  });
});
