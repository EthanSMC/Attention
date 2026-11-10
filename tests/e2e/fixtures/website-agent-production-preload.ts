import { appendFileSync } from "node:fs";

import { assertProductionPreloadEnvironment, offlineProviderFetch } from "./website-agent-offline-provider";

// Only imported into the spawned, synthetic production server, never the app build.
const eventsPath = assertProductionPreloadEnvironment(process.env);
globalThis.fetch = offlineProviderFetch(event => appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }));
