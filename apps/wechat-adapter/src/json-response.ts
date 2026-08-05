export const MAX_JSON_RESPONSE_BYTES = 1_000_000;

export class JsonResponseError extends Error {
  constructor() {
    super("invalid_json_response");
    this.name = "JsonResponseError";
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel("response_body_too_large").catch(() => undefined);
}

async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    await cancelBody(response);
    throw new JsonResponseError();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        break;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (tooLarge) {
    await cancelBody(response);
    throw new JsonResponseError();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonObjectResponse(
  response: Response,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    const body = await readResponseBytesWithinLimit(response, maxBytes);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new JsonResponseError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonResponseError();
  }
  return value as Record<string, unknown>;
}
