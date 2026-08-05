import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

import { ContentTypeSchema, SourceAdapterIdSchema } from "@attention/contracts";

const vaultPayloadSchema = z.object({
  candidates: z
    .array(
      z.object({
        candidateId: z.string().uuid(),
        contentType: ContentTypeSchema,
        dedupeKey: z.string().min(1).max(8_192),
        displayHost: z.string().min(1).max(255),
        source: SourceAdapterIdSchema,
        url: z.string().url().max(4_096),
      }),
    )
    .min(2)
    .max(16),
  selectionToken: z.string().min(32).max(512),
  version: z.literal(2),
  visibility: z.enum(["public", "private"]),
});

export type CandidateVaultPayload = z.infer<typeof vaultPayloadSchema>;

function encryptionKey(): Buffer {
  const secret = process.env.ATTENTION_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("ATTENTION_HMAC_SECRET must contain at least 32 characters");
  }
  return createHash("sha256").update("attention:candidate-vault:v1\0").update(secret).digest();
}

export function encryptCandidateSet(payload: CandidateVaultPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("attention:candidate-vault:v1"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(vaultPayloadSchema.parse(payload)), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((value) => value.toString("base64url")).join(".");
}

export function decryptCandidateSet(value: string): CandidateVaultPayload {
  const [encodedIv, encodedTag, encodedCiphertext, extra] = value.split(".");
  if (!encodedIv || !encodedTag || !encodedCiphertext || extra) {
    throw new Error("invalid_candidate_vault_payload");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAAD(Buffer.from("attention:candidate-vault:v1"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return vaultPayloadSchema.parse(JSON.parse(plaintext));
}
