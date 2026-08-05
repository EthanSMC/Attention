export interface OpenAICompatibleConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface StructuredChatInput {
  signal?: AbortSignal;
  system: string;
  user: string;
}

export interface StructuredChatProvider {
  completeJson(input: StructuredChatInput): Promise<Record<string, unknown>>;
}

export class AiProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, options: { retryable: boolean }) {
    super(code);
    this.name = "AiProviderError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

function parseTimeout(value: string | undefined): number {
  if (!value) return 20_000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("ATTENTION_AI_TIMEOUT_MS must be an integer between 1000 and 120000");
  }
  return parsed;
}

export function loadOpenAICompatibleConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleConfig | null {
  const model = env.ATTENTION_AI_MODEL?.trim();
  if (!model) return null;
  if (model.length > 200) throw new Error("ATTENTION_AI_MODEL is too long");

  const rawBaseUrl = env.ATTENTION_AI_BASE_URL?.trim() || "https://api.openai.com/v1";
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("ATTENTION_AI_BASE_URL must be an absolute URL");
  }
  const loopback = baseUrl.hostname === "127.0.0.1" ||
    baseUrl.hostname === "localhost" ||
    baseUrl.hostname === "[::1]";
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "ATTENTION_AI_BASE_URL must use HTTPS without credentials, query or fragment (HTTP is loopback-only)",
    );
  }

  return {
    apiKey: env.ATTENTION_AI_API_KEY?.trim() || null,
    baseUrl: baseUrl.toString().replace(/\/+$/u, ""),
    model,
    timeoutMs: parseTimeout(env.ATTENTION_AI_TIMEOUT_MS),
  };
}

function parseProviderPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProviderError("ai_invalid_response", { retryable: true });
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AiProviderError("ai_invalid_response", { retryable: true });
  }
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AiProviderError("ai_invalid_response", { retryable: true });
  }
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new AiProviderError("ai_invalid_response", { retryable: true });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiProviderError("ai_invalid_response", { retryable: true });
  }
  return parsed as Record<string, unknown>;
}

export class OpenAICompatibleClient implements StructuredChatProvider {
  constructor(
    private readonly config: OpenAICompatibleConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async completeJson(input: StructuredChatInput): Promise<Record<string, unknown>> {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.config.baseUrl}/chat/completions`,
        {
          body: JSON.stringify({
            messages: [
              { content: input.system, role: "system" },
              { content: input.user, role: "user" },
            ],
            model: this.config.model,
          }),
          headers: {
            ...(this.config.apiKey
              ? { authorization: `Bearer ${this.config.apiKey}` }
              : {}),
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal,
        },
      );
    } catch {
      if (input.signal?.aborted) {
        throw new AiProviderError("ai_request_aborted", { retryable: true });
      }
      throw new AiProviderError("ai_provider_unavailable", { retryable: true });
    }

    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 409 ||
        response.status === 429 || response.status >= 500;
      await response.body?.cancel().catch(() => undefined);
      throw new AiProviderError(
        response.status === 401 || response.status === 403
          ? "ai_provider_unauthorized"
          : "ai_provider_rejected",
        { retryable },
      );
    }

    const raw = await response.text();
    if (raw.length > 1_000_000) {
      throw new AiProviderError("ai_invalid_response", { retryable: true });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new AiProviderError("ai_invalid_response", { retryable: true });
    }
    return parseProviderPayload(payload);
  }
}

export function createConfiguredAiProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
): StructuredChatProvider | null {
  const config = loadOpenAICompatibleConfig(env);
  return config ? new OpenAICompatibleClient(config, fetchImplementation) : null;
}
