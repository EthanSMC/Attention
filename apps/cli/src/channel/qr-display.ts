/**
 * QR rendering for the iLink login flow: an ANSI/ASCII QR in the terminal
 * plus the raw payload as a fallback. Uses `uqr` (pure ESM, zero
 * dependencies) so the CLI stays a single-file bundle.
 */

import { renderANSI } from "uqr";

export interface QrDisplayResult {
  readonly renderedTerminalQr: boolean;
}

export async function displayQrCode(
  payload: string,
  options: {
    readonly writeOutput?: (text: string) => void;
  } = {},
): Promise<QrDisplayResult> {
  const write = options.writeOutput ?? ((text) => process.stdout.write(text));
  let renderedTerminalQr = false;

  try {
    write(`${renderANSI(payload, { border: 1 })}\n`);
    renderedTerminalQr = true;
  } catch {
    // Terminal rendering is best-effort; the raw payload remains printable.
  }

  write(`或直接扫描此内容: ${payload}\n`);
  return { renderedTerminalQr };
}
