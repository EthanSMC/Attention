import { runAttentionCli } from "./main";
import {
  checkCliUpdateAtStartup,
  updateAttentionCli,
} from "./cli-updater";
import { ATTENTION_CLI_VERSION } from "./version";

const exitCode = await runAttentionCli(process.argv.slice(2), {
  checkCliUpdate: async (explicitOrigin) =>
    await checkCliUpdateAtStartup({
      currentVersion: ATTENTION_CLI_VERSION,
      environment: process.env,
      ...(explicitOrigin ? { explicitOrigin } : {}),
    }),
  runCliUpdate: async (explicitOrigin) =>
    await updateAttentionCli({
      ...(process.argv[1] ? { commandPath: process.argv[1] } : {}),
      currentVersion: ATTENTION_CLI_VERSION,
      environment: process.env,
      ...(explicitOrigin ? { explicitOrigin } : {}),
    }),
});
process.exitCode = exitCode;
