import type { InputEnvelope } from "@attention/contracts";

import { isKnownNonContentCandidate } from "./candidate-filter";
import { parseHttpUrl } from "./url";

export const MAX_LINK_CANDIDATES = 16;

export type LinkCandidateSource = "link_card" | "text" | "url";

export interface LinkCandidate {
  readonly url: string;
  readonly source: LinkCandidateSource;
  readonly ordinal: number;
}

const ZERO_WIDTH_CHARACTERS = /[\u200b-\u200d\u2060\ufeff]/gu;
const URL_START = /https?:\/\//giu;
const HARD_TERMINATORS = new Set([
  "<",
  ">",
  '"',
  "'",
  "`",
  "“",
  "”",
  "‘",
  "’",
  "（",
  "）",
  "【",
  "】",
  "《",
  "》",
  "〈",
  "〉",
  "，",
  "。",
  "！",
  "？",
  "；",
  "：",
  "、"
]);
const TRAILING_PUNCTUATION = /[.,;:!?，。！？；：、]+$/u;

export function removeZeroWidthCharacters(value: string): string {
  return value.replace(ZERO_WIDTH_CHARACTERS, "");
}

function isHardTerminator(character: string): boolean {
  return /\s/u.test(character) || HARD_TERMINATORS.has(character);
}

function trimUnmatchedClosingBrackets(value: string): string {
  let result = value;
  const bracketPairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"]
  ] as const;

  let changed = true;
  while (changed && result.length > 0) {
    changed = false;
    for (const [opening, closing] of bracketPairs) {
      if (!result.endsWith(closing)) {
        continue;
      }

      const openings = [...result].filter((character) => character === opening)
        .length;
      const closings = [...result].filter((character) => character === closing)
        .length;
      if (closings > openings) {
        result = result.slice(0, -1);
        changed = true;
      }
    }
  }

  return result;
}

function cleanCandidate(value: string): string | null {
  const withoutPunctuation = value.replace(TRAILING_PUNCTUATION, "");
  const cleaned = trimUnmatchedClosingBrackets(withoutPunctuation);
  return parseHttpUrl(cleaned) === null ? null : cleaned;
}

export function extractUrlsFromText(text: string): readonly string[] {
  const input = removeZeroWidthCharacters(text);
  const urls: string[] = [];
  const seen = new Set<string>();

  URL_START.lastIndex = 0;
  for (let match = URL_START.exec(input); match !== null; match = URL_START.exec(input)) {
    const start = match.index;
    let end = URL_START.lastIndex;

    while (end < input.length) {
      const character = input[end];
      if (character === undefined || isHardTerminator(character)) {
        break;
      }
      end += character.length;
    }

    const cleaned = cleanCandidate(input.slice(start, end));
    if (
      cleaned !== null &&
      !isKnownNonContentCandidate(cleaned) &&
      !seen.has(cleaned)
    ) {
      seen.add(cleaned);
      urls.push(cleaned);
      if (urls.length === MAX_LINK_CANDIDATES) {
        break;
      }
    }

    URL_START.lastIndex = Math.max(URL_START.lastIndex, end);
  }

  return urls;
}

export function extractLinkCandidates(
  envelope: InputEnvelope
): readonly LinkCandidate[] {
  const source: LinkCandidateSource = envelope.payload_type;
  const text =
    envelope.payload_type === "link_card"
      ? envelope.raw_payload.url
      : envelope.raw_payload;

  return extractUrlsFromText(text).map((url, ordinal) => ({
    url,
    source,
    ordinal
  }));
}
