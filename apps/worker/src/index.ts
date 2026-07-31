import { createDatabase } from "@attention/db";

import { loadWorkerConfig } from "./config.js";
import { createStubHandlers } from "./handlers.js";
import { consoleLogger } from "./logger.js";
import { runWorker } from "./worker.js";

async function main() {
  const config = loadWorkerConfig();
  const handle = createDatabase(config.databaseUrl, {
    maxConnections: config.concurrency + 2,
  });
  const controller = new AbortController();
  const stop = () => controller.abort();

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await runWorker({
      config,
      handle,
      handlers: createStubHandlers(),
      logger: consoleLogger,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await handle.close();
  }
}

void main().catch(() => {
  // Configuration/database errors may include credentials in their messages;
  // emit only a stable code at the process boundary.
  consoleLogger.error("worker_start_failed", { errorCode: "startup_error" });
  process.exitCode = 1;
});
