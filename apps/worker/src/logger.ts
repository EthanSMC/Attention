export type SafeLogValue = boolean | number | string | null;
export type SafeLogFields = Record<string, SafeLogValue>;

export interface WorkerLogger {
  error(event: string, fields?: SafeLogFields): void;
  info(event: string, fields?: SafeLogFields): void;
  warn(event: string, fields?: SafeLogFields): void;
}

function emit(level: "error" | "info" | "warn", event: string, fields: SafeLogFields = {}) {
  const entry = JSON.stringify({
    level,
    event,
    ...fields,
    timestamp: new Date().toISOString(),
  });

  if (level === "error") {
    console.error(entry);
    return;
  }

  if (level === "warn") {
    console.warn(entry);
    return;
  }

  console.info(entry);
}

/** Callers may pass identifiers and safe codes, never payloads, URLs, or Error objects. */
export const consoleLogger: WorkerLogger = {
  error: (event, fields) => emit("error", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
};
