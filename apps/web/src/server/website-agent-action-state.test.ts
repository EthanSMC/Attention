import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { appendInterruptedNativeWebsiteSession, createNativeWebsiteSession } from "@attention/website-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTENTION_TOOL_CONTRACT_VERSION } from "./attention-tool-registry";
import { websiteAgentActionArgumentsHash, type WebsiteAgentActionProposal } from "./website-agent-action-policy";
import { appendWebsiteAgentActions, cancelPendingWebsiteAgentActions, parseStoredWebsiteAgentAction,
  parseStoredWebsiteAgentActions, pendingWebsiteAgentAction, settleWebsiteAgentActions, websiteAgentActionViews,
  WEBSITE_AGENT_ACTION_TTL_MS, type StoredWebsiteAgentAction } from "./website-agent-action-state";
import { decryptWebsiteAgentSessionState, encryptWebsiteAgentSessionState, type WebsiteAgentSessionState } from "./website-agent-sessions";

const accountId = "00000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000001";
const authSessionId = "20000000-0000-4000-8000-000000000001";
const originRunId = "30000000-0000-4000-8000-000000000001";
const targetId = "40000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-10T15:00:00.000Z");
const secret = "synthetic-action-state-secret-never-production-12345";
const identity = { accountId, sessionId, revision: 2 };

function proposal(): WebsiteAgentActionProposal {
  const toolName = "attention_update_collection";
  const args = { collection_id: targetId, visibility: "public" };
  return { version: 1, toolName, contractVersion: ATTENTION_TOOL_CONTRACT_VERSION, arguments: args,
    argumentsHash: websiteAgentActionArgumentsHash(toolName, args), targetFingerprint: "b".repeat(64),
    requiredScopes: ["collection:write"], review: { title: "Make collection public",
      details: [{ label: "Collection", value: "Synthetic fixture article" }], consequences: ["Other people may discover the collection."] } };
}
function pending(): StoredWebsiteAgentAction {
  return pendingWebsiteAgentAction({ proposal: proposal(), authSessionId, originRunId, originRevision: 1, now });
}
function executing(): StoredWebsiteAgentAction {
  return { ...pending(), status: "executing", claimId: randomUUID(), deadline: new Date(now.getTime() + 60_000).toISOString() };
}
function terminal(status: "completed" | "failed" | "unknown" = "completed"): StoredWebsiteAgentAction {
  return { ...pending(), status, receipt: { ok: status === "completed", code: status, message: "A factual outcome." } };
}
function state(actions = [pending()]): WebsiteAgentSessionState {
  return { version: 2, actions, pending: null,
    nativeSession: appendInterruptedNativeWebsiteSession(createNativeWebsiteSession(sessionId), "Earlier question", "Earlier public answer") };
}

/** Produce authentic but malformed plaintext to test the decryption boundary, not just the writer. */
function encryptUnchecked(value: unknown): string {
  const key = createHash("sha256").update("attention:website-agent-session:key:v1\0").update(secret).digest();
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(["attention:website-agent-session:v1", accountId, sessionId, identity.revision])));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
beforeEach(() => vi.stubEnv("ATTENTION_WEBSITE_AGENT_SESSION_SECRET", secret));
afterEach(() => vi.unstubAllEnvs());

describe("reviewed action encrypted session envelopes", () => {
  it("roundtrips v2 actions and native Pi history without raw arguments or authority at rest", () => {
    const input = state(), encryptedState = encryptWebsiteAgentSessionState({ ...identity, state: input });
    for (const privateValue of [targetId, authSessionId, originRunId, "Earlier question", "Synthetic fixture article"])
      expect(encryptedState).not.toContain(privateValue);
    expect(encryptWebsiteAgentSessionState({ ...identity, state: input })).not.toBe(encryptedState);
    expect(decryptWebsiteAgentSessionState({ ...identity, encryptedState })).toEqual(input);
  });
  it("continues reading exact legacy v1 state without inventing or losing native history", () => {
    const current = state();
    const legacy: WebsiteAgentSessionState = { version: 1, nativeSession: current.nativeSession, pending: null };
    const encryptedState = encryptUnchecked(legacy);
    expect(decryptWebsiteAgentSessionState({ ...identity, encryptedState })).toEqual(legacy);
  });
  it("authenticates v2 owner, session, revision and ciphertext", () => {
    const encryptedState = encryptWebsiteAgentSessionState({ ...identity, state: state() });
    for (const change of [{ accountId: randomUUID() }, { sessionId: randomUUID() }, { revision: 3 },
      { encryptedState: encryptedState.slice(0, -8) + "AAAAAAAA" }])
      expect(() => decryptWebsiteAgentSessionState({ ...identity, encryptedState, ...change })).toThrow("session_unavailable");
  });
  it("fails closed on authenticated malformed v2 state at both write and read boundaries", () => {
    const current = state(), action = pending();
    const malformed = [
      { ...current, actions: undefined }, { ...current, actions: {} }, { ...current, actions: [action, action] },
      { ...current, rawSource: "untrusted source" }, { ...current, version: 1 },
      { ...current, actions: [{ ...action, arguments: { ...action.arguments, visibility: "private" } }] },
      { ...current, actions: [{ ...action, authSessionId: "guessed" }] },
      { ...current, actions: [{ ...action, originRunId: "guessed" }] },
      { ...current, actions: [{ ...action, token: "synthetic-cookie-not-a-real-token" }] },
      { ...current, actions: [{ ...action, status: "executing" }] },
      { ...current, actions: [{ ...terminal(), receipt: { ok: true, code: "completed", message: "Done",
        value: { arguments: action.arguments, token: "synthetic-cookie-not-a-real-token" } } }] },
    ];
    for (const invalid of malformed) {
      expect(() => encryptWebsiteAgentSessionState({ ...identity, state: invalid as WebsiteAgentSessionState })).toThrow("session_unavailable");
      expect(() => decryptWebsiteAgentSessionState({ ...identity, encryptedState: encryptUnchecked(invalid) })).toThrow("session_unavailable");
    }
  });
});

describe("bounded reviewed action state", () => {
  it("creates distinct pending IDs bound to exact arguments, authentication, run, revision and five-minute expiry", () => {
    const action = pending();
    expect(action).toMatchObject({ ...proposal(), authSessionId, originRunId, originRevision: 1,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + WEBSITE_AGENT_ACTION_TTL_MS).toISOString(),
      status: "pending", claimId: null, deadline: null, receipt: null });
    expect(pending().id).not.toBe(action.id);
  });
  it("validates hash-bound exact arguments, metadata and lifecycle combinations", () => {
    const action = pending();
    for (const change of [
      { argumentsHash: "f".repeat(64) }, { arguments: { ...action.arguments, visibility: "private" } },
      { originRevision: -1 }, { originRevision: 1.5 }, { authSessionId: "invalid" }, { originRunId: "invalid" },
      { createdAt: "yesterday" }, { expiresAt: now.toISOString() },
      { expiresAt: new Date(now.getTime() + WEBSITE_AGENT_ACTION_TTL_MS + 1).toISOString() },
      { status: "executing", claimId: randomUUID(), deadline: null },
      { claimId: randomUUID() }, { deadline: new Date(now.getTime() + 60_000).toISOString() },
      { status: "completed" }, { status: "failed" }, { status: "unknown" },
      { receipt: { ok: true, code: "not_yet", message: "Not executed" } },
      { cookie: "synthetic-cookie-not-a-real-token" },
    ]) expect(() => parseStoredWebsiteAgentAction({ ...action, ...change })).toThrow();
    for (const deadline of [now.toISOString(), new Date(now.getTime() + WEBSITE_AGENT_ACTION_TTL_MS + 1).toISOString()])
      expect(() => parseStoredWebsiteAgentAction({ ...executing(), deadline })).toThrow();
  });
  it("rejects duplicate identities, multiple simultaneous claims, overflow and non-arrays", () => {
    const action = pending();
    for (const value of [null, {}, [action, action], [executing(), executing()], Array.from({ length: 9 }, pending)])
      expect(() => parseStoredWebsiteAgentActions(value)).toThrow();
  });
  it("caps individual and aggregate serialized action bytes rather than only the card count", () => {
    const oversized = { ...pending(), review: { ...proposal().review,
      details: Array.from({ length: 12 }, (_value, index) => ({ label: `Field ${index}`, value: "x".repeat(4_096) })) } };
    expect(() => parseStoredWebsiteAgentAction(oversized)).toThrow();
    const large = () => parseStoredWebsiteAgentAction({ ...pending(), review: { ...proposal().review,
      details: Array.from({ length: 4 }, (_value, index) => ({ label: `Field ${index}`, value: "x".repeat(4_096) })) } });
    const actions = [large(), large(), large()];
    expect(() => parseStoredWebsiteAgentActions(actions)).toThrow();
    expect(() => appendWebsiteAgentActions(actions.slice(0, 2), actions.slice(2))).toThrow();
  });
  it("rejects nested raw results, arguments and credentials rather than allowing them into receipts", () => {
    const action = terminal();
    for (const extra of [{ value: { arguments: action.arguments } }, { value: { token: "synthetic-cookie-not-a-real-token" } },
      { value: { result: "even non-sensitive arbitrary results are not receipt fields" } },
      { token: "synthetic-cookie-not-a-real-token" }, { arguments: action.arguments }])
      expect(() => parseStoredWebsiteAgentAction({ ...action, receipt: { ...action.receipt, ...extra } })).toThrow();
    const [view] = websiteAgentActionViews([action], now);
    expect(Object.keys(view!.receipt!).sort()).toEqual(["ok", "code", "message"].sort());
  });
  it("returns detached state and detached public review/receipt objects", () => {
    const action = terminal(), parsed = parseStoredWebsiteAgentAction(action);
    parsed.arguments.visibility = "private";
    parsed.review.details[0]!.value = "changed";
    parsed.receipt!.message = "changed";
    expect(action.arguments.visibility).toBe("public");
    expect(action.review.details[0]!.value).toBe("Synthetic fixture article");
    expect(action.receipt!.message).toBe("A factual outcome.");
    const [view] = websiteAgentActionViews([action], now);
    view!.review.details[0]!.value = "changed view";
    view!.receipt!.message = "changed view";
    expect(action.review.details[0]!.value).toBe("Synthetic fixture article");
    expect(action.receipt!.message).toBe("A factual outcome.");
  });
  it("exposes only review, fingerprint and safe receipt, never execution arguments or authentication/claim authority", () => {
    const action = executing();
    const [view] = websiteAgentActionViews([action], now);
    expect(Object.keys(view!).sort()).toEqual(["id", "toolName", "argumentsHash", "expiresAt", "status", "review", "receipt"].sort());
    for (const key of ["arguments", "authSessionId", "originRunId", "originRevision", "claimId", "deadline", "targetFingerprint", "requiredScopes", "token"])
      expect(view).not.toHaveProperty(key);
    for (const privateValue of [authSessionId, originRunId, action.claimId, targetId]) expect(JSON.stringify(view)).not.toContain(privateValue!);
  });
  it("expires pending cards exactly at expiry without mutating stored history", () => {
    const action = pending(), atExpiry = new Date(action.expiresAt);
    expect(websiteAgentActionViews([action], new Date(atExpiry.getTime() - 1))[0]!.status).toBe("pending");
    expect(websiteAgentActionViews([action], atExpiry)[0]!.status).toBe("expired");
    expect(settleWebsiteAgentActions([action], atExpiry)[0]!.status).toBe("expired");
    expect(action.status).toBe("pending");
  });
  it("settles a lost claim to unknown at the lease boundary without converting it into retry authority", () => {
    const action = executing(), deadline = new Date(action.deadline!);
    expect(settleWebsiteAgentActions([action], new Date(deadline.getTime() - 1))[0]!.status).toBe("executing");
    const [settled] = settleWebsiteAgentActions([action], deadline);
    expect(settled).toMatchObject({ status: "unknown", claimId: null, deadline: null, receipt: { ok: false, code: "outcome_unknown" } });
    expect(settled!.receipt!.message).toContain("Do not retry automatically");
    expect(settleWebsiteAgentActions([settled!], new Date(now.getTime() + 86400000))).toEqual([settled]);
  });
  it("closes pending and executing cards while preserving known and unknown outcomes", () => {
    const completed = terminal(), unknown = terminal("unknown");
    const actions = [pending(), executing(), completed, unknown];
    expect(settleWebsiteAgentActions(actions, now, true).map(action => action.status)).toEqual(["cancelled", "unknown", "completed", "unknown"]);
    expect(cancelPendingWebsiteAgentActions(actions).map(action => action.status)).toEqual(["cancelled", "executing", "completed", "unknown"]);
    expect(actions[0]!.status).toBe("pending");
  });
  it("retires old safe terminal cards before dropping pending or unknown outcomes", () => {
    const unknown = terminal("unknown"), old = terminal();
    const kept = [unknown, ...Array.from({ length: 6 }, pending)], proposed = pending();
    const prior = [old, ...kept];
    expect(appendWebsiteAgentActions(prior, [proposed])).toEqual([...kept, proposed]);
    expect(prior).toEqual([old, ...kept]);
    expect(() => appendWebsiteAgentActions(Array.from({ length: 8 }, () => terminal("unknown")), [pending()])).toThrow();
    expect(() => appendWebsiteAgentActions([], Array.from({ length: 5 }, pending))).toThrow();
    expect(() => appendWebsiteAgentActions([], [terminal()])).toThrow();
  });
});
