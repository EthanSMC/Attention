import { createDatabase } from "@attention/db";

import { loadWorkerConfig } from "./config.js";
import { runDigestWorker } from "./digest-worker.js";
import { createConfiguredEmailProvider } from "./email-provider.js";
import { consoleLogger } from "./logger.js";
import { createConfiguredProductionHandlers } from "./production-handlers.js";
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
    const digestProvider = config.digestEnabled
      ? createConfiguredEmailProvider()
      : null;
    const primaryWorker = runWorker({
      config,
      handle,
      handlers: createConfiguredProductionHandlers(),
      logger: consoleLogger,
      signal: controller.signal,
    });
    const digestWorker = digestProvider
      ? runDigestWorker({
          config,
          handle,
          logger: consoleLogger,
          provider: digestProvider,
          signal: controller.signal,
        })
      : Promise.resolve();
    await Promise.all([primaryWorker, digestWorker]);
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
