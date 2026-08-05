import "server-only";

import { resolveAccountCapabilities } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";

import {
  AgentAccessError,
  answerAgentQuery,
  type AgentRetrievalResult,
} from "./agent-core";
import { createConfiguredAgentAnswerProvider } from "./agent-provider";
import { loadAgentCandidates } from "./content-queries";

export type { AgentCitation, AgentRetrievalResult } from "./agent-core";
export { AgentAccessError } from "./agent-core";

export async function retrieveForAgent(
  db: AttentionDatabase,
  accountId: string,
  query: string,
): Promise<AgentRetrievalResult> {
  const capabilities = await resolveAccountCapabilities(db, accountId);
  if (!capabilities.isMember) throw new AgentAccessError();
  const candidates = await loadAgentCandidates(db, accountId);
  return answerAgentQuery({
    candidates,
    isMember: capabilities.isMember,
    provider: createConfiguredAgentAnswerProvider(),
    query,
  });
}
