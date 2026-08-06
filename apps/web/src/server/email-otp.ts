import "server-only";

import { normalizeCredentialEndpoint } from "@attention/contracts";

export interface EmailOtpMessage {
  challengeId: string;
  code: string;
  email: string;
  expiresAt: Date;
}

export interface EmailOtpSender {
  send(message: EmailOtpMessage): Promise<void>;
}

const resendTransportRetryDelaysMs = [250, 750] as const;

function isRetryableTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

async function waitForResendRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function maskEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return "***";
  return `${email.slice(0, Math.min(2, separator))}***${email.slice(separator)}`;
}

class ConsoleEmailOtpSender implements EmailOtpSender {
  async send(message: EmailOtpMessage): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Console OTP delivery is disabled in production");
    }
    console.info("attention_email_otp", {
      code: message.code,
      email: maskEmail(message.email),
      expiresAt: message.expiresAt.toISOString(),
    });
  }
}

class WebhookEmailOtpSender implements EmailOtpSender {
  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string,
  ) {}

  async send(message: EmailOtpMessage): Promise<void> {
    const response = await fetch(this.endpoint, {
      body: JSON.stringify({
        code: message.code,
        email: message.email,
        expires_at: message.expiresAt.toISOString(),
        template: "attention-login-code-v1",
      }),
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`OTP email provider returned ${response.status}`);
    }
  }
}

class ResendEmailOtpSender implements EmailOtpSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly templateId: string,
  ) {}

  async send(message: EmailOtpMessage): Promise<void> {
    const validMinutes = Math.max(
      1,
      Math.ceil((message.expiresAt.getTime() - Date.now()) / 60_000),
    );
    let response: Response | undefined;
    for (let attempt = 0; attempt <= resendTransportRetryDelaysMs.length; attempt += 1) {
      try {
        response = await fetch("https://api.resend.com/emails", {
          body: JSON.stringify({
            from: this.from,
            subject: "Attention 登录验证码",
            template: {
              id: this.templateId,
              variables: {
                valid_minutes: String(validMinutes),
                verification_code: message.code,
              },
            },
            to: [message.email],
          }),
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `attention-login-otp:${message.challengeId}`,
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
        break;
      } catch (error) {
        const retryDelayMs = resendTransportRetryDelaysMs[attempt];
        if (retryDelayMs === undefined || !isRetryableTransportError(error)) {
          throw error;
        }
        await waitForResendRetry(retryDelayMs);
      }
    }
    if (!response) throw new Error("OTP email provider did not respond");
    if (!response.ok) {
      throw new Error(`OTP email provider returned ${response.status}`);
    }
    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("id" in result) ||
      typeof result.id !== "string" ||
      !result.id.trim()
    ) {
      throw new Error("OTP email provider returned an invalid response");
    }
    console.info("attention_email_otp_sent", {
      email: maskEmail(message.email),
      providerMessageId: result.id,
    });
  }
}

export function getEmailOtpSender(
  env: NodeJS.ProcessEnv = process.env,
): EmailOtpSender {
  const provider = env.ATTENTION_EMAIL_PROVIDER?.trim() || "console";
  if (provider === "console") return new ConsoleEmailOtpSender();
  if (provider === "webhook") {
    const endpoint = env.ATTENTION_EMAIL_WEBHOOK_URL?.trim();
    const bearerToken = env.ATTENTION_EMAIL_WEBHOOK_TOKEN?.trim();
    if (!endpoint || !bearerToken) {
      throw new Error(
        "ATTENTION_EMAIL_WEBHOOK_URL and ATTENTION_EMAIL_WEBHOOK_TOKEN are required",
      );
    }
    return new WebhookEmailOtpSender(
      normalizeCredentialEndpoint(endpoint, "ATTENTION_EMAIL_WEBHOOK_URL"),
      bearerToken,
    );
  }
  if (provider === "resend") {
    const apiKey = env.RESEND_API_KEY?.trim();
    const from = env.ATTENTION_RESEND_FROM?.trim();
    const templateId = env.ATTENTION_RESEND_TEMPLATE_ID?.trim();
    if (!apiKey || !from || !templateId) {
      throw new Error(
        "RESEND_API_KEY, ATTENTION_RESEND_FROM, and ATTENTION_RESEND_TEMPLATE_ID are required",
      );
    }
    return new ResendEmailOtpSender(apiKey, from, templateId);
  }
  throw new Error(`Unsupported ATTENTION_EMAIL_PROVIDER: ${provider}`);
}
