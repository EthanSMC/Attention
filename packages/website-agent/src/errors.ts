export interface WebsiteAgentToolReceipt {
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed" | "unknown";
}

export interface WebsiteAgentUsage {
  modelCalls: number;
  toolCalls: number;
  /** Provider-reported usage, not a billing guarantee. Includes reported cache input. */
  inputTokens: number;
  outputTokens: number;
  /** Conservative preflight maximum, retained even after failures or cancellation. No automatic refund. */
  reservedCostMicrousd: number;
  /** Estimate at peak rates based on reported usage. This is not a provider invoice. */
  observedCostMicrousd: number;
}

export type WebsiteAgentErrorCode =
  | "invalid_configuration" | "invalid_input" | "invalid_session" | "session_full" | "budget_exceeded" | "context_limit"
  | "model_limit" | "tool_limit" | "tool_input_limit" | "tool_output_limit"
  | "output_limit" | "unknown_tool" | "invalid_tool_arguments" | "tool_error"
  | "provider_error" | "permission_revoked" | "empty_answer" | "cancelled" | "timeout";

export const ERROR_MESSAGES: Record<WebsiteAgentErrorCode, string> = {
  invalid_configuration: "Website agent configuration is invalid.",
  invalid_input: "Provide a nonempty text prompt within the configured limit.",
  invalid_session: "The stored native website session is invalid.",
  session_full: "The native website session has reached its storage limit. Start a new session.",
  budget_exceeded: "The website agent run reached its reserved cost budget.",
  context_limit: "The website agent context exceeded its limit.",
  model_limit: "The website agent reached its model call limit.",
  tool_limit: "The website agent reached its tool call limit.",
  tool_input_limit: "The tool input exceeded its limit.",
  tool_output_limit: "The tool output exceeded its limit.",
  output_limit: "The model response exceeded its output limit.",
  unknown_tool: "The model requested an unavailable tool.",
  invalid_tool_arguments: "The model supplied invalid tool arguments.",
  tool_error: "An Attention tool could not complete the request.",
  provider_error: "The model provider could not complete the request.",
  permission_revoked: "Permission to run the website agent is no longer available.",
  empty_answer: "The model did not return a final answer.",
  cancelled: "The website agent run was cancelled.",
  timeout: "The website agent run timed out.",
};

export class WebsiteAgentError extends Error {
  readonly code: WebsiteAgentErrorCode;
  readonly usage: WebsiteAgentUsage;
  readonly toolReceipts: WebsiteAgentToolReceipt[];

  constructor(code: WebsiteAgentErrorCode, usage: WebsiteAgentUsage = emptyUsage(), receipts: WebsiteAgentToolReceipt[] = []) {
    super(ERROR_MESSAGES[code]);
    this.name = "WebsiteAgentError";
    this.code = code;
    this.usage = { ...usage };
    this.toolReceipts = receipts.map((receipt) => ({ ...receipt }));
  }
}

export function emptyUsage(): WebsiteAgentUsage {
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, reservedCostMicrousd: 0, observedCostMicrousd: 0 };
}
