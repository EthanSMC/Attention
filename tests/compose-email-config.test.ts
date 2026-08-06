import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "../apps/worker/src/config";
import { createConfiguredEmailProvider } from "../apps/worker/src/email-provider";

function parseEnvExample(source: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid env example line: ${line}`);
        const key = line.slice(0, separator);
        const rawValue = line.slice(separator + 1);
        const value =
          rawValue.startsWith('"') && rawValue.endsWith('"')
            ? rawValue.slice(1, -1)
            : rawValue;
        return [key, value];
      }),
  );
}

function serviceEnvironmentExpressions(
  composeSource: string,
  service: string,
): Record<string, string> {
  const lines = composeSource.split(/\r?\n/u);
  const serviceStart = lines.findIndex((line) => line === `  ${service}:`);
  if (serviceStart < 0) throw new Error(`Missing Compose service: ${service}`);
  const environmentStart = lines.findIndex(
    (line, index) => index > serviceStart && line === "    environment:",
  );
  if (environmentStart < 0) {
    throw new Error(`Missing environment for Compose service: ${service}`);
  }

  const entries: Array<[string, string]> = [];
  for (const line of lines.slice(environmentStart + 1)) {
    if (/^ {4}\S/u.test(line)) break;
    const match = /^ {6}([A-Z][A-Z0-9_]+):\s*(.*)$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) entries.push([match[1], match[2]]);
  }
  return Object.fromEntries(entries);
}

function interpolateComposeValue(value: string, env: NodeJS.ProcessEnv): string {
  const expression = /^\$\{([A-Z][A-Z0-9_]+)(?:(:-|:\?)(.*))?\}$/u.exec(value);
  if (!expression) return value;
  const [, name = "", operator, operand = ""] = expression;
  const configured = env[name];
  if (configured) return configured;
  if (!operator) return "";
  if (operator === ":-") return operand;
  throw new Error(operand || `${name} is required`);
}

function resolveServiceEnvironment(
  composeSource: string,
  service: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(serviceEnvironmentExpressions(composeSource, service)).map(
      ([name, value]) => [name, interpolateComposeValue(value, env)],
    ),
  );
}

describe("Compose email configuration", () => {
  it("boots the Resend login-only example without digest webhook credentials", () => {
    const root = resolve(import.meta.dirname, "..");
    const example = parseEnvExample(
      readFileSync(resolve(root, ".env.compose.example"), "utf8"),
    );
    const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");

    expect(example).toMatchObject({
      ATTENTION_CONSUMER_INVITE_QUOTA: "1",
      ATTENTION_DIGEST_WORKER_ENABLED: "false",
      ATTENTION_EMAIL_PROVIDER: "resend",
      ATTENTION_EMAIL_WEBHOOK_TOKEN: "",
      ATTENTION_EMAIL_WEBHOOK_URL: "",
      ATTENTION_RESEND_FROM: "Attention <no_reply@service.noveltystudio.cn>",
      ATTENTION_RESEND_TEMPLATE_ID: "attention-login-code",
      RESEND_API_KEY: "replace-me-with-a-dedicated-resend-api-key",
    });

    const web = resolveServiceEnvironment(compose, "web", example);
    expect(web).toMatchObject({
      ATTENTION_CONSUMER_INVITE_QUOTA: "1",
      ATTENTION_EMAIL_PROVIDER: "resend",
      ATTENTION_RESEND_FROM: "Attention <no_reply@service.noveltystudio.cn>",
      ATTENTION_RESEND_TEMPLATE_ID: "attention-login-code",
      RESEND_API_KEY: "replace-me-with-a-dedicated-resend-api-key",
    });

    const worker = resolveServiceEnvironment(compose, "worker", example);
    expect(worker).toMatchObject({
      ATTENTION_DIGEST_WORKER_ENABLED: "false",
      ATTENTION_EMAIL_PROVIDER: "webhook",
      ATTENTION_EMAIL_WEBHOOK_TOKEN: "",
      ATTENTION_EMAIL_WEBHOOK_URL: "",
    });
    expect(
      loadWorkerConfig({
        ...worker,
        NODE_ENV: "production",
      }).digestEnabled,
    ).toBe(false);
  });

  it("fails closed when digests are enabled without webhook credentials", () => {
    expect(() =>
      createConfiguredEmailProvider({
        ATTENTION_EMAIL_PROVIDER: "webhook",
        ATTENTION_EMAIL_WEBHOOK_TOKEN: "",
        ATTENTION_EMAIL_WEBHOOK_URL: "",
        NODE_ENV: "production",
      }),
    ).toThrow(
      "ATTENTION_EMAIL_WEBHOOK_URL and ATTENTION_EMAIL_WEBHOOK_TOKEN are required",
    );
  });
});
