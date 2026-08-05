import "server-only";

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request_body_too_large");
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidRequestBodyError extends Error {
  constructor() {
    super("invalid_request_body");
    this.name = "InvalidRequestBodyError";
  }
}

export async function readRequestBytesWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request_body_too_large").catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonRequestWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const body = await readRequestBytesWithinLimit(request, maxBytes);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    throw new InvalidRequestBodyError();
  }
}

export async function readUrlEncodedRequestWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<URLSearchParams> {
  const body = await readRequestBytesWithinLimit(request, maxBytes);
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    throw new InvalidRequestBodyError();
  }
}
