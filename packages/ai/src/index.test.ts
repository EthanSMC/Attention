import { describe, expect, it, vi } from "vitest";

import {
  loadOpenAICompatibleConfig,
  OpenAICompatibleClient,
} from "./index";

const config = {
  apiKey: "test-key",
  baseUrl: "https://ai.example.test/v1",
  model: "test-model",
  timeoutMs: 2_000,
};

describe("OpenAI-compatible provider", () => {
  it("is disabled unless a model is explicitly configured", () => {
    expect(loadOpenAICompatibleConfig({})).toBeNull();
  });

  it.each([
    "http://ai.example.test/v1",
    "https://user:password@ai.example.test/v1",
    "https://ai.example.test/v1?key=unsafe",
    "https://ai.example.test/v1#fragment",
  ])("rejects an unsafe provider base URL: %s", (baseUrl) => {
    expect(() => loadOpenAICompatibleConfig({
      ATTENTION_AI_BASE_URL: baseUrl,
      ATTENTION_AI_MODEL: "test-model",
    })).toThrow(/HTTPS/u);
  });

  it("allows loopback HTTP for a local model gateway", () => {
    expect(loadOpenAICompatibleConfig({
      ATTENTION_AI_BASE_URL: "http://127.0.0.1:11434/v1",
      ATTENTION_AI_MODEL: "local-model",
    })?.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("parses a structured response without exposing the API key in the body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer":"ok"}' } }],
    }), { status: 200 }));
    const client = new OpenAICompatibleClient(config, fetchMock);

    await expect(client.completeJson({ system: "system", user: "user" }))
      .resolves.toEqual({ answer: "ok" });
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://ai.example.test/v1/chat/completions");
    expect(request?.[1]?.redirect).toBe("error");
    expect(String(request?.[1]?.body)).not.toContain("test-key");
  });

  it.each([
    [401, false, "ai_provider_unauthorized"],
    [429, true, "ai_provider_rejected"],
    [503, true, "ai_provider_rejected"],
  ])("classifies HTTP %i failures", async (status, retryable, code) => {
    const client = new OpenAICompatibleClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
    );
    const rejection = client.completeJson({ system: "system", user: "user" });
    await expect(rejection).rejects.toMatchObject({
      code,
      retryable,
    });
  });
});
