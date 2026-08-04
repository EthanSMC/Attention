import { createConfiguredAiProvider, type StructuredChatProvider } from "@attention/ai";

import type { AgentAnswerProvider } from "./agent-core";

function parseAnswer(
  value: Record<string, unknown>,
  sourceKeys: Map<string, string>,
): { answer: string; citedSourceKeys: string[] } {
  if (typeof value.answer !== "string" || !Array.isArray(value.citations) ||
    value.citations.some((citation) => typeof citation !== "string")) {
    throw new Error("invalid_agent_answer");
  }
  const citedSourceKeys = value.citations.map((citation) => sourceKeys.get(citation));
  if (citedSourceKeys.some((key) => !key)) throw new Error("invalid_agent_citation");
  return { answer: value.answer, citedSourceKeys: citedSourceKeys as string[] };
}

export function createAgentAnswerProvider(
  provider: StructuredChatProvider,
): AgentAnswerProvider {
  return {
    async answer(input) {
      const sourceKeys = new Map<string, string>();
      const sources = input.sources.map((source, index) => {
        const reference = `S${index + 1}`;
        sourceKeys.set(reference, source.key);
        return {
          author: source.author,
          reference,
          scope: source.scope,
          source: source.source,
          summary: source.summary,
          tags: source.tags,
          title: source.title,
        };
      });
      const response = await provider.completeJson({
        system: [
          "Answer the user's question in Chinese using only the supplied saved-link metadata.",
          "Return JSON with answer and citations, where citations is an array of supplied reference values such as S1.",
          "Every factual claim must be grounded in a cited source. Never invent or cite an unknown reference.",
          "Explain uncertainty and ask the user to open the original links when metadata is insufficient.",
        ].join(" "),
        user: JSON.stringify({ query: input.query, sources }),
      });
      return parseAnswer(response, sourceKeys);
    },
  };
}

export function createConfiguredAgentAnswerProvider(
  env: NodeJS.ProcessEnv = process.env,
): AgentAnswerProvider | null {
  const provider = createConfiguredAiProvider(env);
  return provider ? createAgentAnswerProvider(provider) : null;
}
