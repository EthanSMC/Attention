import { normalizeCredentialEndpoint } from "@attention/contracts";

export interface EmailMessage {
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string;
}

export interface EmailSendResult {
  providerMessageId: string | null;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class EmailProviderError extends Error {
  readonly code = "email_provider_unavailable";

  constructor() {
    super("email_provider_unavailable");
    this.name = "EmailProviderError";
  }
}

class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Console email delivery is disabled in production");
    }
    console.info("attention_digest_email", {
      idempotencyKey: message.idempotencyKey,
      subject: message.subject,
    });
    return { providerMessageId: `console:${message.idempotencyKey}` };
  }
}

class WebhookEmailProvider implements EmailProvider {
  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        body: JSON.stringify({
          email: message.to,
          html: message.html,
          message_id: message.idempotencyKey,
          subject: message.subject,
          template: "attention-daily-digest-v1",
          text: message.text,
        }),
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new EmailProviderError();
    }
    if (!response.ok) throw new EmailProviderError();
    const body = (await response.json().catch(() => null)) as
      | { message_id?: unknown }
      | null;
    return {
      providerMessageId:
        typeof body?.message_id === "string" ? body.message_id.slice(0, 255) : null,
    };
  }
}

export function createConfiguredEmailProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmailProvider {
  const provider = env.ATTENTION_EMAIL_PROVIDER?.trim() || "console";
  if (provider === "console") {
    if (env.NODE_ENV === "production") {
      throw new Error("ATTENTION_EMAIL_PROVIDER=webhook is required in production");
    }
    return new ConsoleEmailProvider();
  }
  if (provider === "webhook") {
    const endpoint = env.ATTENTION_EMAIL_WEBHOOK_URL?.trim();
    const bearerToken = env.ATTENTION_EMAIL_WEBHOOK_TOKEN?.trim();
    if (!endpoint || !bearerToken) {
      throw new Error(
        "ATTENTION_EMAIL_WEBHOOK_URL and ATTENTION_EMAIL_WEBHOOK_TOKEN are required",
      );
    }
    return new WebhookEmailProvider(
      normalizeCredentialEndpoint(endpoint, "ATTENTION_EMAIL_WEBHOOK_URL"),
      bearerToken,
    );
  }
  throw new Error(`Unsupported ATTENTION_EMAIL_PROVIDER: ${provider}`);
}
