/** Explicit opt-in host acceptance. Uses an isolated test home, no login or running Bridge. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { CodexAppServerRpc } from "../apps/cli/src/channel/codex-app-server-rpc";
import { localControlPaths, prepareLocalControl, writeControlJson } from "../apps/cli/src/local-control";
import { localControlSandbox, localControlThreadConfig } from "../apps/cli/src/channel/codex-local-control";

const [codexExecutable, cliBundle] = process.argv.slice(2);
assert(codexExecutable && cliBundle, "usage: check-codex-local-control-sandbox <codex> <built-cli>");
const home = await realpath(await mkdtemp(join(tmpdir(), "attention-sandbox-acceptance-")));
const paths = localControlPaths(home);
await prepareLocalControl(home);
const codexHome = join(home, "codex-home"); await mkdir(codexHome, { mode: 0o700 });
const channel = join(home, ".attention/channel"); await mkdir(channel, { mode: 0o700 });
const journal = join(channel, "update-journal.json"); await writeFile(journal, "test-only-protected", { mode: 0o600 });
await writeControlJson(paths.status, { schemaVersion: 1, instanceId: "a".repeat(32), binding: "b".repeat(64), pid: process.pid, updatedAt: Date.now(), runningVersion: "0.3.18", service: "running", runtime: "degraded_auth", mcp: "auth_required", update: { phase: "idle", candidateVersion: null, latestVerified: null, lastErrorCode: null } });
const rpc = new CodexAppServerRpc({ executable: resolve(codexExecutable), cwd: paths.workspace, environment: { CODEX_HOME: codexHome }, args: ["app-server", "--stdio"] });
const server = createServer(socket => socket.end());
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const localProfile = { workspace: paths.workspace, requests: paths.requests, command: [process.execPath, resolve(cliBundle)] as const };
const policy = localControlSandbox(localProfile);
async function exec(command: string[]) {
  return await rpc.request<{ exitCode: number; stdout: string; stderr: string }>("command/exec", { command, cwd: paths.workspace, sandboxPolicy: policy, timeoutMs: 10000, outputBytesCap: 4000, env: { HOME: home } });
}
try {
  await rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "attention_sandbox_acceptance", version: "1" }, capabilities: { experimentalApi: true } });
  const thread = await rpc.request<{ thread: { id: string }; sandbox: typeof policy }>("thread/start", { ...localControlThreadConfig(localProfile), model: "gpt-5.6-luna" });
  assert.equal(thread.sandbox.type, policy.type);
  assert.equal(thread.sandbox.networkAccess, false);
  // A new zero-turn thread has no persisted rollout in some hosts; resume is
  // covered by adapter regression tests, not claimed as a real conversation test.
  const status = await exec([process.execPath, resolve(cliBundle), "channel", "update", "status", "--json"]);
  assert.equal(status.exitCode, 0, `CLI status failed: ${status.stderr}`);
  const localStatus = JSON.parse(status.stdout);
  assert.equal(localStatus.lastKnownVersion, "0.3.18");
  assert(localStatus.online === true || localStatus.online === null);
  const request = await exec([process.execPath, resolve(cliBundle), "channel", "update", "check", "--json"]);
  assert.equal(request.exitCode, 0, `CLI request failed: ${request.stderr}`);
  assert.equal(JSON.parse(request.stdout).status, "submitted");
  const probes = { workspace: join(paths.workspace, "allowed"), inbox: join(paths.requests, "allowed"), journal, status: paths.status, result: join(paths.results, "forged.json"), outside: join(home, "denied"), tmp: join(home, "tmp-denied") };
  const checks = await exec([process.execPath, "--input-type=module", "-e", `
    import {writeFileSync} from 'node:fs';
    import {connect} from 'node:net';
    const r = {};
    for (const [key,path] of Object.entries(${JSON.stringify(probes)})) { try {writeFileSync(path,'probe');r[key]='allowed'} catch(e) {r[key]=e.code} }
    r.network = await new Promise(resolve => {const s=connect(${port},'127.0.0.1');s.setTimeout(1500);s.on('connect',()=>{s.destroy();resolve('allowed')});s.on('error',e=>resolve(e.code));s.on('timeout',()=>{s.destroy();resolve('timeout')})});
    console.log(JSON.stringify(r));
  `]);
  assert.equal(checks.exitCode, 0, `sandbox probe failed: ${checks.stderr}`);
  const evidence = JSON.parse(checks.stdout);
  assert.equal(evidence.workspace, "allowed"); assert.equal(evidence.inbox, "allowed");
  for (const key of ["journal", "status", "result", "outside", "tmp", "network"]) assert(["EPERM", "EACCES"].includes(evidence[key]), `${key}: expected sandbox denial, got ${evidence[key]}`);
  console.log(JSON.stringify({ status: "passed", cliStatus: true, cliSubmit: true, evidence }));
} finally {
  await rpc.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
}
