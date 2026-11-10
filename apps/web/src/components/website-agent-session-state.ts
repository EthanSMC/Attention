/** A delayed poll must never replace a newer view or a different interaction. */
export function canApplyWebsiteSessionUpdate(input: {
  generation: number; currentGeneration: number; aborted: boolean;
  expectedSessionId: string; actualSessionId: string;
  previousRevision: number; incomingRevision: number;
}): boolean {
  return !input.aborted && input.generation === input.currentGeneration &&
    input.expectedSessionId === input.actualSessionId && Number.isSafeInteger(input.incomingRevision) &&
    input.incomingRevision >= input.previousRevision;
}

/** A deep link is resolved by the owner-scoped server endpoint, not a list page. */
export function websiteSessionIdToLoad(requestedId: string | null, sessions: readonly { id: string; status: string }[]): string | null {
  return requestedId || sessions.find(session => session.status === "open")?.id || null;
}
