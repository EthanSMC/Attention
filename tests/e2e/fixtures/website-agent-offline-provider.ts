export const productionFixtureMarker = "attention-website-production-acceptance-v1";
export const providerKey = "offline-production-provider-key";
export const helloPrompt = "Production acceptance: say hello.";
export const resumePrompt = "Production acceptance: resume the earlier hello.";
export const digestPrompt = "Production acceptance: propose the fixed synthetic digest settings.";
export const helloAnswer = "Synthetic production hello.";
export const resumeAnswer = "Synthetic production conversation resumed.";
export const digestAnswer = "Review the pending digest card before confirming.";
export const digestArguments = { enabled: true, domain_slugs: [], timezone: "UTC", window_start: "09:15", window_minutes: 30 };

export function assertProductionPreloadEnvironment(env: Readonly<Record<string, string | undefined>>): string {
  const database = new URL(env.DATABASE_URL ?? "invalid:");
  if (env.TEST_WEBSITE_AGENT_PRODUCTION !== productionFixtureMarker || env.NODE_ENV !== "production" ||
      env.ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY !== providerKey ||
      !/^postgres(?:ql)?:$/u.test(database.protocol) || database.username !== "attention_web_runtime" ||
      database.hostname !== "127.0.0.1" || !database.password || database.search || database.hash ||
      !/^\/attention_website_http_test_production(?:_[a-z0-9]+)*$/u.test(database.pathname) ||
      !env.TEST_WEBSITE_AGENT_PROVIDER_EVENTS) {
    throw new Error("Refusing offline provider preload outside the marked production test process");
  }
  return env.TEST_WEBSITE_AGENT_PROVIDER_EVENTS;
}

type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown };
type Event = { kind: "hello" | "resume" | "digest_proposal" | "digest_review" };
function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(part => part?.type === "text" && typeof part.text === "string"))
    return value.map(part => part.text as string).join("");
  return undefined;
}

/** Test-process-only fetch replacement. No passthrough or configurable command/data dispatch. */
export function offlineProviderFetch(record: (event: Event) => void): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (request.url !== "https://api.deepseek.com/chat/completions" || request.method !== "POST" ||
        request.headers.get("authorization") !== `Bearer ${providerKey}`) {
      throw new Error("Offline production acceptance blocked an unexpected fetch");
    }
    const body = await request.json() as { model?: string; stream?: boolean; messages?: Message[] };
    if (body.model !== "deepseek-flash" || body.stream !== true || !Array.isArray(body.messages)) {
      throw new Error("Offline production acceptance rejected provider protocol");
    }
    const lastUserIndex = body.messages.findLastIndex(message => message.role === "user");
    const prompt = textContent(body.messages[lastUserIndex]?.content);
    let answer: string;
    let tool = false;
    if (prompt === helloPrompt) {
      record({ kind: "hello" });
      answer = helloAnswer;
    } else if (prompt === resumePrompt && body.messages.slice(0, lastUserIndex)
      .some(message => message.role === "assistant" && textContent(message.content) === helloAnswer)) {
      record({ kind: "resume" });
      answer = resumeAnswer;
    } else if (prompt === digestPrompt) {
      tool = !body.messages.slice(lastUserIndex + 1).some(message => message.role === "tool");
      record({ kind: tool ? "digest_proposal" : "digest_review" });
      answer = digestAnswer;
    } else {
      throw new Error("Offline production acceptance rejected an unknown synthetic prompt");
    }
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_production_digest",
      type: "function", function: { name: "attention_update_digest_settings", arguments: JSON.stringify(digestArguments) } }] }
      : { role: "assistant", content: answer };
    return new Response([
      `data: ${JSON.stringify({ id: "offline-production", object: "chat.completion.chunk", model: "deepseek-flash",
        choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "offline-production", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  };
}
