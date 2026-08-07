import { runAttentionCli } from "./main";

const exitCode = await runAttentionCli(process.argv.slice(2));
process.exitCode = exitCode;
