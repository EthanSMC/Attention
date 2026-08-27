/**
 * Configuration management for the Attention DSH plugin.
 *
 * Reads from environment variables with sensible defaults.
 */

export interface AttentionConfig {
  /** Attention server origin (e.g. http://127.0.0.1:3000) */
  readonly baseUrl: string;
  /** Bearer token for Attention API authentication */
  readonly apiKey: string;
  /** MCP endpoint path (default: /mcp) */
  readonly mcpPath: string;
  /** Request timeout in milliseconds */
  readonly timeoutMs: number;
  /** Maximum retry attempts for failed requests */
  readonly maxRetries: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export function loadAttentionConfig(
  overrides?: Partial<AttentionConfig>,
): AttentionConfig {
  return {
    baseUrl:
      overrides?.baseUrl ??
      process.env["ATTENTION_BASE_URL"] ??
      DEFAULT_BASE_URL,
    apiKey:
      overrides?.apiKey ??
      process.env["ATTENTION_API_KEY"] ??
      "",
    mcpPath:
      overrides?.mcpPath ??
      process.env["ATTENTION_MCP_PATH"] ??
      DEFAULT_MCP_PATH,
    timeoutMs:
      overrides?.timeoutMs ??
      (() => {
        const env = process.env["ATTENTION_TIMEOUT_MS"];
        return env ? Number(env) : DEFAULT_TIMEOUT_MS;
      })(),
    maxRetries:
      overrides?.maxRetries ??
      (() => {
        const env = process.env["ATTENTION_MAX_RETRIES"];
        return env ? Number(env) : DEFAULT_MAX_RETRIES;
      })(),
  };
}

export function mcpEndpoint(config: AttentionConfig): string {
  const base = config.baseUrl.replace(/\/+$/u, "");
  const path = config.mcpPath.startsWith("/")
    ? config.mcpPath
    : "/" + config.mcpPath;
  return base + path;
}
