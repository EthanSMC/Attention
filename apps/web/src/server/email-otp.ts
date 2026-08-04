import "server-only";

export interface EmailOtpMessage {
  code: string;
  email: string;
  expiresAt: Date;
}

export interface EmailOtpSender {
  send(message: EmailOtpMessage): Promise<void>;
}

class ConsoleEmailOtpSender implements EmailOtpSender {
  async send(message: EmailOtpMessage): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Console OTP delivery is disabled in production");
    }
    console.info("attention_email_otp", {
      code: message.code,
      email: message.email.replace(/^(.{2}).+(@.+)$/u, "$1***$2"),
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
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`OTP email provider returned ${response.status}`);
    }
  }
}

export function getEmailOtpSender(): EmailOtpSender {
  const provider = process.env.ATTENTION_EMAIL_PROVIDER?.trim() || "console";
  if (provider === "console") return new ConsoleEmailOtpSender();
  if (provider === "webhook") {
    const endpoint = process.env.ATTENTION_EMAIL_WEBHOOK_URL?.trim();
    const bearerToken = process.env.ATTENTION_EMAIL_WEBHOOK_TOKEN?.trim();
    if (!endpoint || !bearerToken) {
      throw new Error(
        "ATTENTION_EMAIL_WEBHOOK_URL and ATTENTION_EMAIL_WEBHOOK_TOKEN are required",
      );
    }
    return new WebhookEmailOtpSender(endpoint, bearerToken);
  }
  throw new Error(`Unsupported ATTENTION_EMAIL_PROVIDER: ${provider}`);
}

export function mayExposeDevelopmentOtp(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ATTENTION_AUTH_EXPOSE_OTP?.trim().toLocaleLowerCase("en-US") === "true"
  );
}
