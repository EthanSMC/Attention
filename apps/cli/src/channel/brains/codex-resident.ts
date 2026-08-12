import {
  CodexAppServerRpc,
  CodexAppServerRpcError,
  type CodexAppServerRpcOptions,
  type CodexRpcNotification,
  type CodexRpcSnapshot,
} from "../codex-app-server-rpc";
import {
  type BrainAdapter,
  type BrainInvokeInput,
  type BrainOutcome,
  type BrainRuntimeSnapshot,
} from "../brain";
import { BRAIN_TIMEOUT_MS, CODEX_RESTART_BACKOFF_MS } from "../limits";
import { CHANNEL_HOST_SYSTEM_POLICY } from "../prompt";
import { ATTENTION_CLI_VERSION } from "../../version";
import {
  applyAttentionToolResult,
  mcpResultPayload,
  type CollectionReplyControl,
} from "../collection-reply-control";

const CODEX_MODEL = "gpt-5.6-luna";
const CODEX_REASONING_EFFORT = "medium";
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 1_000;
const CHANNEL_DEVELOPER_INSTRUCTIONS = CHANNEL_HOST_SYSTEM_POLICY;

interface McpServerStatus {
  readonly name?: unknown;
}

interface McpServerStatusList {
  readonly data?: readonly McpServerStatus[];
}

interface ThreadResult {
  readonly thread?: { readonly id?: unknown };
}

interface TurnResult {
  readonly turn?: { readonly id?: unknown };
}

interface ActiveTurn {
  collectionReplyControl: CollectionReplyControl | null;
  readonly resolve: (outcome: BrainOutcome) => void;
  readonly threadId: string;
  readonly timer: NodeJS.Timeout;
  readonly turnId: string;
  reply: string;
}

export interface CodexResidentRpc {
  start(): Promise<void>;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  onNotification(listener: (event: CodexRpcNotification) => void): () => void;
  snapshot(): CodexRpcSnapshot;
  close(): Promise<void>;
}

export interface CodexResidentBrainOptions {
  readonly healthCheckIntervalMs?: number;
  readonly mcpUrl: string;
  readonly restartBackoffMs?: readonly number[];
  readonly rpc?: CodexResidentRpc;
  readonly rpcFactory?: (options: CodexAppServerRpcOptions) => CodexResidentRpc;
  readonly rpcOptions?: CodexAppServerRpcOptions;
  readonly turnTimeoutMs?: number;
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

function errorText(error: unknown): string {
  if (error instanceof CodexAppServerRpcError) {
    let data = "";
    try {
      data = JSON.stringify(error.data);
    } catch {
      // The structured payload is diagnostic only.
    }
    return `${error.message} ${data}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationError(error: unknown): boolean {
  return /\b401\b|unauthori[sz]ed|authentication|auth required|codex login/iu.test(
    errorText(error),
  );
}

function isMissingThreadError(error: unknown): boolean {
  return /thread[^\n]*(?:not found|missing|unknown)|(?:not found|missing|unknown)[^\n]*thread|no (?:conversation|session)/iu.test(
    errorText(error),
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexAppServerRpcError(
      "protocol_error",
      `Codex app-server returned no ${label}`,
    );
  }
  return value;
}

function notificationRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function createCodexResidentBrain(
  options: CodexResidentBrainOptions,
): BrainAdapter {
  const rpc =
    options.rpc ??
    (options.rpcFactory ?? ((rpcOptions) => new CodexAppServerRpc(rpcOptions)))(
      options.rpcOptions ?? { args: ["app-server", "--stdio"] },
    );
  const restartBackoff =
    options.restartBackoffMs && options.restartBackoffMs.length > 0
      ? options.restartBackoffMs
      : CODEX_RESTART_BACKOFF_MS;
  const healthInterval =
    options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const turnTimeout = options.turnTimeoutMs ?? BRAIN_TIMEOUT_MS;

  let activeTurn: ActiveTurn | null = null;
  let acceptingInvocations = true;
  let attachedThreadId: string | null = null;
  let currentThreadId: string | null = null;
  let desiredRunning = false;
  let healthTimer: NodeJS.Timeout | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let startPromise: Promise<boolean> | null = null;
  let invokeTail: Promise<void> = Promise.resolve();
  let lifecycleGeneration = 0;
  let snapshot: BrainRuntimeSnapshot = {
    lastErrorCode: null,
    phase: "starting",
    retryAttempt: 0,
  };
  const bufferedNotifications: CodexRpcNotification[] = [];

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

  const handleNotification = (event: CodexRpcNotification): boolean => {
    const params = notificationRecord(event.params);
    if (!params) return false;
    const pending = activeTurn;
    if (!pending) return false;
    if (
      params.threadId !== pending.threadId ||
      (notificationRecord(params.turn)?.id ?? params.turnId) !== pending.turnId
    ) {
      return false;
    }
    if (event.method === "item/completed") {
      const item = notificationRecord(params.item);
      if (
        item?.type === "mcpToolCall" &&
        item.server === "attention" &&
        (item.status === "completed" || item.status === "failed") &&
        typeof item.tool === "string"
      ) {
        pending.collectionReplyControl = applyAttentionToolResult(
          pending.collectionReplyControl,
          item.tool,
          mcpResultPayload(item.result),
        );
      }
      if (
        item?.type === "agentMessage" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0
      ) {
        pending.reply = item.text.trim();
      }
      return true;
    }
    if (event.method !== "turn/completed") return false;
    const turn = notificationRecord(params.turn);
    const completedSuccessfully = turn?.status === "completed";
    finishActiveTurn({
      ok: completedSuccessfully && pending.reply.length > 0,
      reply: completedSuccessfully ? pending.reply : "",
      ...(pending.collectionReplyControl
        ? { collectionReplyControl: pending.collectionReplyControl }
        : {}),
      resumeFailed: false,
      sessionId: pending.threadId,
      timedOut: false,
    });
    return true;
  };

  rpc.onNotification((event) => {
    if (!handleNotification(event)) {
      bufferedNotifications.push(event);
      if (bufferedNotifications.length > 64) bufferedNotifications.shift();
    }
  });

  const verifyMcpIsolation = async (): Promise<void> => {
    let status: McpServerStatusList;
    try {
      status = await rpc.request<McpServerStatusList>(
        "mcpServerStatus/list",
        {},
      );
    } catch (error) {
      throw new CodexAppServerRpcError(
        "protocol_error",
        "Codex MCP isolation status was unavailable",
        error,
      );
    }
    const names = (status.data ?? []).map((entry) => entry.name);
    if (names.length !== 1 || names[0] !== "attention") {
      throw new CodexAppServerRpcError(
        "protocol_error",
        "Codex MCP isolation check failed",
      );
    }
  };

  const initialize = async (): Promise<void> => {
    await rpc.request("initialize", {
      capabilities: null,
      clientInfo: {
        name: "attention-channel",
        title: "Attention",
        version: ATTENTION_CLI_VERSION,
      },
    });
    await verifyMcpIsolation();
  };

  const scheduleRestart = (): void => {
    if (!desiredRunning || restartTimer) return;
    const retryAttempt = Math.max(1, snapshot.retryAttempt);
    const delay =
      restartBackoff[
        Math.min(retryAttempt - 1, restartBackoff.length - 1)
      ] ?? restartBackoff.at(-1) ?? 15_000;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void startRuntime(true);
    }, delay);
  };

  const markCrashed = (): void => {
    if (!desiredRunning || snapshot.phase === "restarting") return;
    attachedThreadId = null;
    transition("restarting", "codex_runtime_crashed", 1);
    finishActiveTurn(emptyFailure({ sessionId: currentThreadId }));
    scheduleRestart();
  };

  const startRuntime = async (restart: boolean): Promise<boolean> => {
    if (startPromise) return await startPromise;
    if (rpc.snapshot().phase === "running" && snapshot.phase === "healthy") {
      return true;
    }
    startPromise = (async () => {
      if (!restart) transition("starting", null, 0);
      try {
        await rpc.start();
        await initialize();
        attachedThreadId = null;
        transition("healthy", null, 0);
        return true;
      } catch (error) {
        attachedThreadId = null;
        if (isAuthenticationError(error)) {
          transition("degraded_auth", "codex_auth_required", 0);
          return false;
        }
        if (
          error instanceof CodexAppServerRpcError &&
          error.code === "protocol_error" &&
          /MCP isolation/iu.test(error.message)
        ) {
          transition("degraded_runtime", "codex_mcp_isolation_failed", 0);
          return false;
        }
        if (restart && desiredRunning) {
          transition(
            "restarting",
            "codex_runtime_crashed",
            snapshot.retryAttempt + 1,
          );
          scheduleRestart();
        } else {
          transition("degraded_runtime", "codex_runtime_start_failed", 0);
        }
        return false;
      } finally {
        startPromise = null;
      }
    })();
    return await startPromise;
  };

  const ensureHealthMonitor = (): void => {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      if (
        desiredRunning &&
        snapshot.phase === "healthy" &&
        rpc.snapshot().phase !== "running"
      ) {
        markCrashed();
      }
    }, healthInterval);
  };

  const start = async (): Promise<void> => {
    acceptingInvocations = true;
    desiredRunning = true;
    ensureHealthMonitor();
    const healthy = await startRuntime(false);
    if (!healthy) {
      throw new Error(snapshot.lastErrorCode ?? "codex_runtime_start_failed");
    }
  };

  const ensureStarted = async (): Promise<boolean> => {
    desiredRunning = true;
    ensureHealthMonitor();
    const recoverableRequestFailure =
      snapshot.phase === "degraded_runtime" &&
      (snapshot.lastErrorCode === "codex_thread_failed" ||
        snapshot.lastErrorCode === "codex_turn_start_failed");
    if (
      rpc.snapshot().phase === "running" &&
      (snapshot.phase === "healthy" ||
        snapshot.phase === "recovering_thread" ||
        snapshot.phase === "replaying_history" ||
        recoverableRequestFailure)
    ) {
      return true;
    }
    if (snapshot.phase === "restarting") return false;
    return await startRuntime(false);
  };

  const attachThread = async (input: BrainInvokeInput): Promise<string> => {
    if (input.sessionId) {
      if (attachedThreadId === input.sessionId) return input.sessionId;
      transition("recovering_thread", null, snapshot.retryAttempt);
      const result = await rpc.request<ThreadResult>("thread/resume", {
        threadId: input.sessionId,
      });
      const threadId = requiredString(result.thread?.id, "thread id");
      currentThreadId = threadId;
      attachedThreadId = threadId;
      transition("healthy", null, 0);
      return threadId;
    }
    const result = await rpc.request<ThreadResult>("thread/start", {
      approvalPolicy: "never",
      cwd: input.cwd,
      developerInstructions: CHANNEL_DEVELOPER_INSTRUCTIONS,
      model: CODEX_MODEL,
      sandbox: "read-only",
    });
    const threadId = requiredString(result.thread?.id, "thread id");
    currentThreadId = threadId;
    attachedThreadId = threadId;
    transition("healthy", null, 0);
    return threadId;
  };

  const invokeOne = async (input: BrainInvokeInput): Promise<BrainOutcome> => {
    if (!(await ensureStarted())) return emptyFailure();
    let threadId: string;
    try {
      threadId = await attachThread(input);
    } catch (error) {
      if (isAuthenticationError(error)) {
        transition("degraded_auth", "codex_auth_required", 0);
        return emptyFailure();
      }
      if (input.sessionId && isMissingThreadError(error)) {
        currentThreadId = null;
        attachedThreadId = null;
        transition("replaying_history", "codex_thread_missing", 0);
        return emptyFailure({ resumeFailed: true });
      }
      if (rpc.snapshot().phase !== "running") markCrashed();
      else transition("degraded_runtime", "codex_thread_failed", 0);
      return emptyFailure({ sessionId: currentThreadId });
    }

    let turnId: string;
    try {
      const result = await rpc.request<TurnResult>("turn/start", {
        effort: CODEX_REASONING_EFFORT,
        input: [{ text: input.prompt, text_elements: [], type: "text" }],
        model: CODEX_MODEL,
        // Native Responses web search is configured independently by
        // `web_search="live"`. Keep ordinary sandbox networking closed so no
        // shell or future local tool can turn this into general egress.
        sandboxPolicy: { networkAccess: false, type: "readOnly" },
        threadId,
      });
      turnId = requiredString(result.turn?.id, "turn id");
    } catch (error) {
      if (isAuthenticationError(error)) {
        transition("degraded_auth", "codex_auth_required", 0);
      } else if (rpc.snapshot().phase !== "running") {
        markCrashed();
      } else {
        transition("degraded_runtime", "codex_turn_start_failed", 0);
      }
      return emptyFailure({ sessionId: threadId });
    }

    return await new Promise<BrainOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = activeTurn;
        if (!pending || pending.turnId !== turnId) return;
        activeTurn = null;
        void rpc
          .request("turn/interrupt", { threadId, turnId })
          .catch(() => undefined);
        resolve(
          emptyFailure({ sessionId: threadId, timedOut: true }),
        );
      }, turnTimeout);
      activeTurn = {
        collectionReplyControl: null,
        reply: "",
        resolve,
        threadId,
        timer,
        turnId,
      };
      const buffered = bufferedNotifications.splice(0);
      for (const event of buffered) {
        if (!handleNotification(event)) bufferedNotifications.push(event);
        if (!activeTurn) break;
      }
    });
  };

  return {
    hostId: "codex",
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
        await rpc
          .request("turn/interrupt", {
            threadId: pending.threadId,
            turnId: pending.turnId,
          })
          .catch(() => undefined);
        pending.resolve(emptyFailure({ sessionId: pending.threadId }));
      }
      await rpc.close();
      attachedThreadId = null;
      transition("stopped", null, 0);
    },
    start,
  };
}
