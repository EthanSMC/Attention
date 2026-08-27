/**
 * Runtime Reporter - optional health checkpoints for Attention.
 */

export interface RuntimeReporterOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly installationId: string;
  readonly heartbeatIntervalMs?: number;
}

export interface RuntimeReporter {
  start(): void;
  stop(): void;
  reportHealthy(): Promise<void>;
  reportDegraded(code: string): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 60_000;

export function createRuntimeReporter(
  options: RuntimeReporterOptions,
): RuntimeReporter {
  let timer: ReturnType<typeof setInterval> | null = null;
  const interval = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;

  async function sendHeartbeat(): Promise<void> {
    try {
      await fetch(options.baseUrl + '/api/runtime/installations/' + options.installationId, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + options.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'healthy',
          last_heartbeat_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* heartbeat failures are non-fatal */ }
  }

  return {
    start() {
      if (timer) return;
      sendHeartbeat().catch(() => {});
      timer = setInterval(() => { sendHeartbeat().catch(() => {}); }, interval);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    async reportHealthy() { await sendHeartbeat(); },
    async reportDegraded(code: string) {
      try {
        await fetch(options.baseUrl + '/api/runtime/installations/' + options.installationId, {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + options.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'degraded',
            last_error_code: code,
            last_heartbeat_at: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch { /* non-fatal */ }
    },
  };
}
