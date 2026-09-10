import { describe, expect, it } from "vitest";

import { formatInvocation, shellQuote, runCommand } from "./command-runner";
import { boundedDiagnosticOutput, redactSecrets } from "./redact";

describe("command diagnostics", () => {
  it("renders copyable commands without using a shell", () => {
    expect(
      formatInvocation({
        args: ["mcp", "add", "attention", "--url", "https://example.test/mcp"],
        executable: "codex",
      }),
    ).toBe("codex mcp add attention --url https://example.test/mcp");
    expect(shellQuote("a value's suffix")).toBe("'a value'\"'\"'s suffix'");
  });

  it("redacts credentials before output", () => {
    const value = [
      "Authorization: Bearer abc.def.ghi",
      "access_token=secret-value",
      "https://example.test/callback?code=one-time-code",
      "re_abcdefghijklmnopqrstuvwxyz",
    ].join("\n");
    const redacted = redactSecrets(value);
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("one-time-code");
    expect(redacted).not.toContain("re_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toContain("[REDACTED]");
  });

  it("bounds untrusted command output", () => {
    expect(boundedDiagnosticOutput("x".repeat(50), 10)).toBe(
      "xxxxxxxxxx\n… output truncated",
    );
  });
});

it("terminates a running candidate when its update operation is cancelled",async()=>{
 const abort=new AbortController();
 const timer=setTimeout(()=>abort.abort(),100);
 try{
   const result=await runCommand({executable:process.execPath,args:["-e","setInterval(()=>{},1000)"]},{timeoutMs:5000,signal:abort.signal});
   expect(result.signal).toBe("SIGTERM");expect(result.timedOut).toBe(false);
 }finally{clearTimeout(timer);}
});
it("does not spawn after cancellation",async()=>{
 const abort=new AbortController();abort.abort();
 await expect(runCommand({executable:process.execPath,args:["-e","throw new Error('must not execute')"]},{signal:abort.signal})).rejects.toThrow();
});
