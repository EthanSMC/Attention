import type { SafeLogger } from "./types.js";

const safeFieldNames = new Set([
  "code",
  "encrypted",
  "host",
  "mode",
  "port",
  "provider",
  "status",
]);

function record(
  level: "error" | "info" | "warn",
  event: string,
  fields?: Record<string, boolean | number | string>,
): void {
  const payload: Record<string, boolean | number | string> = {
    event: /^[a-z0-9_]{1,80}$/u.test(event) ? event : "unknown_event",
    level,
  };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!safeFieldNames.has(key)) continue;
    payload[key] = typeof value === "string" ? value.slice(0, 128) : value;
  }
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const safeLogger: SafeLogger = {
  error: (event, fields) => record("error", event, fields),
  info: (event, fields) => record("info", event, fields),
  warn: (event, fields) => record("warn", event, fields),
};
