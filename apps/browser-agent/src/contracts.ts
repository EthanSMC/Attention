import { z } from "zod";

export const BROWSER_TASK_TTL_MS = 30 * 60_000;
export const BROWSER_ACTION_TIMEOUT_MS = 60_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const BrowserGrantSchema = z.object({
  grant_id: z.string().uuid(),
  account_id: z.string().uuid(),
  collection_id: z.string().uuid(),
  source_revision: z.string().regex(/^[a-f0-9]{64}$/),
  source_url: z.string().url().max(4096),
  expires_at: z.number().int().positive(),
}).strict();
export type BrowserGrant = z.infer<typeof BrowserGrantSchema>;
export const BrowserOpenInputSchema = z.object({
  grant: z.string().min(32).max(4096).describe("Short-lived browser grant issued by Attention for the owned collection. Never a URL or browser cookie."),
}).strict();
export const BrowserTaskInputSchema = z.object({
  task_id: z.string().uuid().describe("Task returned by attention_browser_open_collection."),
}).strict();
export const BrowserErrorCodeSchema = z.enum([
  "invalid_request", "permission_revoked", "task_expired", "task_not_found", "browser_busy",
  "browser_unavailable", "browser_timeout", "unsafe_source", "source_changed", "cancelled",
]);
export type BrowserErrorCode = z.infer<typeof BrowserErrorCodeSchema>;
export class BrowserTaskError extends Error {
  constructor(readonly code: BrowserErrorCode) { super(code); this.name = "BrowserTaskError"; }
}
export const BrowserTaskResultSchema = z.object({
  task_id: z.string().uuid(),
  collection_id: z.string().uuid(),
  source_revision: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["opened", "needs_user_verification", "ready", "incomplete", "closed"]),
  expires_at: z.number().int().positive(),
  last_read_at: z.number().int().nonnegative().nullable(),
  read_count: z.number().int().nonnegative(),
  // Status calls deliberately omit evidence. Reading is a separate operation.
  evidence: z.object({
    title: z.string().max(500),
    text: z.string().max(MAX_BODY_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source_url: z.string().url().max(4096),
    visibility: z.literal("account_private"),
    complete: z.boolean(),
  }).strict().optional(),
}).strict();
export type BrowserTaskResult = z.infer<typeof BrowserTaskResultSchema>;
