import {
  ClaudeStreamRpc,
  ClaudeStreamRpcError,
  type ClaudeStreamMessage,
  type ClaudeStreamRpcOptions,
  type ClaudeStreamSnapshot,
} from "../claude-stream-rpc";
import {
  type BrainAdapter,
  type BrainInvokeInput,
  type BrainOutcome,
  type BrainRuntimeSnapshot,
} from "../brain";
import {
  BRAIN_TIMEOUT_MS,
  CLAUDE_RESTART_BACKOFF_MS,
} from "../limits";
import { CHANNEL_HOST_SYSTEM_POLICY } from "../prompt";
import { ATTENTION_CHANNEL_MCP_TOOL_NAMES } from "./codex";
import {
  applyAttentionToolResult,
  mcpResultPayload,
  type CollectionReplyControl,
} from "../collection-reply-control";

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 1_000;

export interface ClaudeResidentRpc {
  start(): Promise<void>;
  onMessage(listener: (message: ClaudeStreamMessage) => void): () => void;
  send(message: ClaudeStreamMessage): void;
  snapshot(): ClaudeStreamSnapshot;
  close(): Promise<void>;
}

export interface ClaudeResidentRpcFactoryInput {
  readonly cwd: string;
  readonly sessionId: string | null;
}

export interface ClaudeResidentBrainOptions {
  readonly healthCheckIntervalMs?: number;
  readonly mcpUrl: string;
  readonly restartBackoffMs?: readonly number[];
  readonly rpcFactory?: (
    input: ClaudeResidentRpcFactoryInput,
  ) => ClaudeResidentRpc;
  readonly runtimeDirectory?: string;
  readonly turnTimeoutMs?: number;
}

interface ActiveTurn {
  collectionReplyControl: CollectionReplyControl | null;
  readonly pendingToolNames: Map<string, string>;
  reply: string;
  readonly requestedSessionId: string | null;
  readonly resolve: (outcome: BrainOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

function emptyFailure(
  overrides: Partial<BrainOutcome> = {},
): BrainOutcome {
  return {
    ok: false,
    reply: "",
    resumeFailed: false,
    sessionId: null,
    timedOut: false,
    ...overrides,
  };
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function assistantText(message: ClaudeStreamMessage): string {
  const envelope = objectRecord(message.message);
  const content = envelope?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      const block = objectRecord(entry);
      return block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("")
    .trim();
}

function observeClaudeAttentionTools(
  message: ClaudeStreamMessage,
  current: CollectionReplyControl | null,
  pendingToolNames: Map<string, string>,
): CollectionReplyControl | null {
  const content = objectRecord(message.message)?.content;
  if (!Array.isArray(content)) return current;
  let next = current;
  for (const entry of content) {
    const block = objectRecord(entry);
    if (!block) continue;
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      block.name.startsWith("mcp__attention__")
    ) {
      pendingToolNames.set(block.id, block.name);
      continue;
    }
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      continue;
    }
    const toolName = pendingToolNames.get(block.tool_use_id);
    if (!toolName) continue;
    pendingToolNames.delete(block.tool_use_id);
    if (block.is_error === true) {
      next = applyAttentionToolResult(next, toolName, null);
      continue;
    }
    next = applyAttentionToolResult(
      next,
      toolName,
      mcpResultPayload(block.content),
    );
  }
  return next;
}

function unresolvedCollectionTool(
  pendingToolNames: ReadonlyMap<string, string>,
): boolean {
  return [...pendingToolNames.values()].some((name) =>
    /attention_(?:collect_content|select_collection_candidate)$/u.test(name),
  );
}

function isMissingSessionText(text: string): boolean {
  return /no conversation found|could not resume|session[^\n]*(?:not found|missing|unknown)|(?:not found|missing|unknown)[^\n]*session/iu.test(
    text,
  );
}

function isAuthenticationText(text: string): boolean {
  return /\b401\b|unauthori[sz]ed|authentication|auth required|claude login/iu.test(
    text,
  );
}

export function buildClaudeResidentArgs(
  mcpUrl: string,
  sessionId: string | null,
): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        attention: { type: "http", url: mcpUrl },
      },
    }),
    "--no-chrome",
    "--append-system-prompt",
    CHANNEL_HOST_SYSTEM_POLICY,
    "--tools",
    "WebFetch,WebSearch",
    "--allowedTools",
    "WebFetch",
    "WebSearch",
    ...ATTENTION_CHANNEL_MCP_TOOL_NAMES.map(
      (name) => `mcp__attention__${name}`,
    ),
  ];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export function createClaudeResidentBrain(
  options: ClaudeResidentBrainOptions,
): BrainAdapter {
  const rpcFactory =
    options.rpcFactory ??
    ((input: ClaudeResidentRpcFactoryInput) =>
      new ClaudeStreamRpc({
        args: buildClaudeResidentArgs(options.mcpUrl, input.sessionId),
        cwd: input.cwd,
      } satisfies ClaudeStreamRpcOptions));
  const healthInterval =
    options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const restartBackoff =
    options.restartBackoffMs && options.restartBackoffMs.length > 0
      ? options.restartBackoffMs
      : CLAUDE_RESTART_BACKOFF_MS;
  const turnTimeout = options.turnTimeoutMs ?? BRAIN_TIMEOUT_MS;

  let acceptingInvocations = true;
  let activeTurn: ActiveTurn | null = null;
  let currentSessionId: string | null = null;
  let desiredRunning = false;
  let healthTimer: NodeJS.Timeout | null = null;
  let invokeTail: Promise<void> = Promise.resolve();
  let lastRuntimeContext: ClaudeResidentRpcFactoryInput | null = null;
  let lifecycleGeneration = 0;
  let processCompletedTurn = false;
  let requestedSessionId: string | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let rpc: ClaudeResidentRpc | null = null;
  let startPromise: Promise<boolean> | null = null;
  let unsubscribe: (() => void) | null = null;
  let snapshot: BrainRuntimeSnapshot = {
    lastErrorCode: null,
    phase: "starting",
    retryAttempt: 0,
  };
  const transition = (
    phase: BrainRuntimeSnapshot["phase"],
    lastErrorCode: string | null,
    retryAttempt = snapshot.retryAttempt,
  ): void => {
    snapshot = { lastErrorCode, phase, retryAttempt };
  };

  const finishActiveTurn = (outcome: BrainOutcome): void => {
    const pending = activeTurn;
    if (!pending) return;
    activeTurn = null;
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  };

  const handleMessage = (message: ClaudeStreamMessage): void => {
    const sessionId = stringField(message, "session_id");
    if (sessionId) currentSessionId = sessionId;
    if (activeTurn) {
      activeTurn.collectionReplyControl = observeClaudeAttentionTools(
        message,
        activeTurn.collectionReplyControl,
        activeTurn.pendingToolNames,
      );
    }
    if (message.type === "assistant" && activeTurn) {
      const text = assistantText(message);
      if (text) activeTurn.reply = text;
      return;
    }
    if (message.type !== "result" || !activeTurn) return;
    const pending = activeTurn;
    const resultText = stringField(message, "result") ?? pending.reply;
    const subtype = stringField(message, "subtype");
    const isError = message.is_error === true || subtype?.startsWith("error") === true;
    const resolvedSessionId =
      sessionId ?? currentSessionId ?? pending.requestedSessionId;
    if (
      pending.collectionReplyControl === null &&
      unresolvedCollectionTool(pending.pendingToolNames)
    ) {
      pending.collectionReplyControl = {
        kind: "fixed",
        reply: "收藏结果无法确认，请稍后重试。",
      };
    }
    pending.pendingToolNames.clear();
    processCompletedTurn = true;
    if (isError) {
      const missingSession =
        pending.requestedSessionId !== null && isMissingSessionText(resultText);
      transition(
        missingSession ? "replaying_history" : "degraded_runtime",
        missingSession ? "claude_session_missing" : "claude_turn_failed",
        0,
      );
      finishActiveTurn(
        emptyFailure({
          resumeFailed: missingSession,
          sessionId: resolvedSessionId,
        }),
      );
      return;
    }
    if (resolvedSessionId && lastRuntimeContext) {
      lastRuntimeContext = {
        ...lastRuntimeContext,
        sessionId: resolvedSessionId,
      };
    }
    transition("healthy", null, 0);
    finishActiveTurn({
      ok:
        resultText.trim().length > 0 ||
        pending.collectionReplyControl !== null,
      reply: resultText.trim(),
      ...(pending.collectionReplyControl
        ? { collectionReplyControl: pending.collectionReplyControl }
        : {}),
      resumeFailed: false,
      sessionId: resolvedSessionId,
      timedOut: false,
    });
  };

  const detachRpc = (): ClaudeResidentRpc | null => {
    const previous = rpc;
    unsubscribe?.();
    unsubscribe = null;
    rpc = null;
    return previous;
  };

  const closeCurrentRpc = async (): Promise<void> => {
    const previous = detachRpc();
    if (previous) await previous.close();
  };

  const startRuntime = async (
    context: ClaudeResidentRpcFactoryInput,
    restart: boolean,
  ): Promise<boolean> => {
    if (startPromise) return await startPromise;
    startPromise = (async () => {
      if (!restart) transition("starting", null, 0);
      await closeCurrentRpc();
      currentSessionId = null;
      processCompletedTurn = false;
      requestedSessionId = context.sessionId;
      lastRuntimeContext = context;
      const candidate = rpcFactory(context);
      rpc = candidate;
      unsubscribe = candidate.onMessage(handleMessage);
      try {
        await candidate.start();
        transition("healthy", null, 0);
        return true;
      } catch (error) {
        detachRpc();
        await candidate.close().catch(() => undefined);
        const errorText = error instanceof Error ? error.message : String(error);
        if (isAuthenticationText(errorText)) {
          transition("degraded_auth", "claude_auth_required", 0);
        } else if (restart && desiredRunning) {
          transition(
            "restarting",
            "claude_runtime_crashed",
            snapshot.retryAttempt + 1,
          );
          scheduleRestart();
        } else {
          transition("degraded_runtime", "claude_runtime_start_failed", 0);
        }
        return false;
      } finally {
        startPromise = null;
      }
    })();
    return await startPromise;
  };

  const scheduleRestart = (): void => {
    if (!desiredRunning || restartTimer || !lastRuntimeContext) return;
    const retryAttempt = Math.max(1, snapshot.retryAttempt);
    const delay =
      restartBackoff[
        Math.min(retryAttempt - 1, restartBackoff.length - 1)
      ] ?? restartBackoff.at(-1) ?? 15_000;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      const context = lastRuntimeContext;
      if (context) void startRuntime(context, true);
    }, delay);
  };

  const markCrashed = (): void => {
    const failedRpc = rpc;
    if (!desiredRunning || !failedRpc) return;
    const processSnapshot = failedRpc.snapshot();
    detachRpc();
    const errorText = processSnapshot.stderr;
    if (isAuthenticationText(errorText)) {
      transition("degraded_auth", "claude_auth_required", 0);
    } else {
      transition("restarting", "claude_runtime_crashed", 1);
      scheduleRestart();
    }
    finishActiveTurn(
      emptyFailure({ sessionId: currentSessionId ?? requestedSessionId }),
    );
  };

  const ensureHealthMonitor = (): void => {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      if (
        desiredRunning &&
        rpc &&
        rpc.snapshot().phase !== "running" &&
        snapshot.phase !== "restarting"
      ) {
        markCrashed();
      }
    }, healthInterval);
  };

  const start = async (): Promise<void> => {
    acceptingInvocations = true;
    desiredRunning = true;
    ensureHealthMonitor();
    if (!options.runtimeDirectory) {
      transition("healthy", null, 0);
      return;
    }
    const healthy = await startRuntime(
      { cwd: options.runtimeDirectory, sessionId: null },
      false,
    );
    if (!healthy) {
      throw new Error(snapshot.lastErrorCode ?? "claude_runtime_start_failed");
    }
  };

  const processMatches = (input: BrainInvokeInput): boolean => {
    if (!rpc || rpc.snapshot().phase !== "running") return false;
    if (input.sessionId) {
      return (
        input.sessionId === currentSessionId ||
        (currentSessionId === null && input.sessionId === requestedSessionId)
      );
    }
    return requestedSessionId === null && !processCompletedTurn;
  };

  const ensureProcess = async (input: BrainInvokeInput): Promise<boolean> => {
    desiredRunning = true;
    ensureHealthMonitor();
    if (processMatches(input)) return true;
    if (snapshot.phase === "restarting" && !rpc) return false;
    return await startRuntime(
      { cwd: input.cwd, sessionId: input.sessionId },
      false,
    );
  };

  const invokeOne = async (input: BrainInvokeInput): Promise<BrainOutcome> => {
    if (!(await ensureProcess(input)) || !rpc) return emptyFailure();
    if (input.sessionId) {
      transition("recovering_thread", null, snapshot.retryAttempt);
    }
    return await new Promise<BrainOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = activeTurn;
        if (!pending) return;
        activeTurn = null;
        const sessionId = currentSessionId ?? pending.requestedSessionId;
        void closeCurrentRpc();
        transition("degraded_runtime", "claude_turn_timeout", 0);
        pending.resolve(
          emptyFailure({ sessionId, timedOut: true }),
        );
      }, turnTimeout);
      activeTurn = {
        collectionReplyControl: null,
        pendingToolNames: new Map(),
        reply: "",
        requestedSessionId: input.sessionId,
        resolve,
        timer,
      };
      try {
        rpc?.send({
          message: {
            content: [{ text: input.prompt, type: "text" }],
            role: "user",
          },
          type: "user",
        });
      } catch (error) {
        activeTurn = null;
        clearTimeout(timer);
        if (error instanceof ClaudeStreamRpcError) {
          transition("degraded_runtime", "claude_runtime_write_failed", 0);
        }
        resolve(emptyFailure({ sessionId: currentSessionId }));
      }
    });
  };

  return {
    hostId: "claude-code",
    async invoke(input: BrainInvokeInput): Promise<BrainOutcome> {
      if (!acceptingInvocations) return emptyFailure();
      const invocationGeneration = lifecycleGeneration;
      let resolveQueued!: (outcome: BrainOutcome) => void;
      const outcome = new Promise<BrainOutcome>((resolve) => {
        resolveQueued = resolve;
      });
      const task = invokeTail.then(async () => {
        if (
          !acceptingInvocations ||
          invocationGeneration !== lifecycleGeneration
        ) {
          resolveQueued(emptyFailure());
          return;
        }
        resolveQueued(await invokeOne(input));
      });
      invokeTail = task.catch(() => undefined);
      return await outcome;
    },
    runtimeSnapshot(): BrainRuntimeSnapshot {
      return { ...snapshot };
    },
    async shutdown(): Promise<void> {
      acceptingInvocations = false;
      lifecycleGeneration += 1;
      desiredRunning = false;
      if (healthTimer) clearInterval(healthTimer);
      if (restartTimer) clearTimeout(restartTimer);
      healthTimer = null;
      restartTimer = null;
      if (activeTurn) {
        const pending = activeTurn;
        activeTurn = null;
        clearTimeout(pending.timer);
        pending.resolve(
          emptyFailure({ sessionId: currentSessionId ?? requestedSessionId }),
        );
      }
      await closeCurrentRpc();
      currentSessionId = null;
      requestedSessionId = null;
      processCompletedTurn = false;
      transition("stopped", null, 0);
    },
    start,
  };
}
