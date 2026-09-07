import {pathToFileURL} from "node:url";
import {readDocument} from "../apps/fetcher/src/read-document.ts";
import {safeFetch} from "../apps/fetcher/src/safe-fetch.ts";

/** Anonymous static diagnostics only: explicit URL, no account/config or browser. */
export async function checkPublicReader(args: string[], staticRead: typeof safeFetch = safeFetch) {
  if (args.length !== 2 || args[0] !== "--url") {
    return {status: "invalid_configuration", classification: "expected_public_url", method: [], length: 0};
  }
  let url: URL;
  try {url = new URL(args[1]!);} catch {
    return {status: "invalid_configuration", classification: "invalid_url", method: [], length: 0};
  }
  const result = await readDocument({url: url.toString(),
    sourceKind: url.hostname === "mp.weixin.qq.com" ? "wechat_official_article" : "generic_web",
    request_ref: "anonymous-diagnostic", attempt_ref: "anonymous-static", signal: new AbortController().signal},
  {staticRead, browser: null, now: Date.now});
  return {status: result.outcome, classification: result.outcome === "ready" ? "article" : result.outcome === "skipped" ? result.reason : result.code,
    method: result.attempts.map(attempt => attempt.method), length: result.outcome === "ready" ? result.temporary_text.length : 0};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await checkPublicReader(process.argv.slice(2));
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "ready" ? 0 : 1;
  } catch {
    console.log(JSON.stringify({status: "failed", classification: "unknown_reader_error", method: null, length: 0}));
    process.exitCode = 1;
  }
}
