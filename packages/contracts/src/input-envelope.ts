import { z } from "zod";

export const MAX_RAW_TEXT_LENGTH = 32_768;
export const MAX_RAW_URL_LENGTH = 4_096;

export const InputChannelSchema = z.enum(["web", "wechat"]);
export type InputChannel = z.infer<typeof InputChannelSchema>;

export const PayloadTypeSchema = z.enum(["text", "link_card", "url"]);
export type PayloadType = z.infer<typeof PayloadTypeSchema>;

const EnvelopeMetadataSchema = z.object({
  channel: InputChannelSchema,
  sender_account_id: z.string().min(1).max(128),
  channel_message_id: z.string().min(1).max(256),
  received_at: z.string().datetime({ offset: true }),
  parser_version: z.string().min(1).max(64)
});

export const TextInputEnvelopeSchema = EnvelopeMetadataSchema.extend({
  payload_type: z.literal("text"),
  raw_payload: z.string().min(1).max(MAX_RAW_TEXT_LENGTH)
}).strict();

export const UrlInputEnvelopeSchema = EnvelopeMetadataSchema.extend({
  payload_type: z.literal("url"),
  raw_payload: z.string().min(1).max(MAX_RAW_URL_LENGTH)
}).strict();

export const LinkCardPayloadSchema = z
  .object({
    url: z.string().min(1).max(MAX_RAW_URL_LENGTH),
    title: z.string().max(1_024).optional(),
    description: z.string().max(4_096).optional()
  })
  .strict();

export const LinkCardInputEnvelopeSchema = EnvelopeMetadataSchema.extend({
  payload_type: z.literal("link_card"),
  raw_payload: LinkCardPayloadSchema
}).strict();

export const InputEnvelopeSchema = z.discriminatedUnion("payload_type", [
  TextInputEnvelopeSchema,
  UrlInputEnvelopeSchema,
  LinkCardInputEnvelopeSchema
]);

export type TextInputEnvelope = z.infer<typeof TextInputEnvelopeSchema>;
export type UrlInputEnvelope = z.infer<typeof UrlInputEnvelopeSchema>;
export type LinkCardPayload = z.infer<typeof LinkCardPayloadSchema>;
export type LinkCardInputEnvelope = z.infer<
  typeof LinkCardInputEnvelopeSchema
>;
export type InputEnvelope = z.infer<typeof InputEnvelopeSchema>;
