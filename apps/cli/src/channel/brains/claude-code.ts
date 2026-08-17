/**
 * Claude Code Channel adapter.
 *
 * Claude Code 2.1.226 supports a long-lived print-mode process through
 * `--input-format stream-json --output-format stream-json`. The resident
 * adapter keeps that process alive across WeChat turns, persists Claude's
 * session id through the shared Channel state, resumes it after Bridge
 * restart, and lets the shared pipeline replay the last 20 turns when Claude
 * reports that a stored session no longer exists.
 */

import type { BrainAdapter } from "../brain";
import {
  createClaudeResidentBrain,
  type ClaudeResidentBrainOptions,
} from "./claude-resident";

export type ClaudeCodeBrainOptions = ClaudeResidentBrainOptions;

export function createClaudeCodeBrain(
  options: ClaudeCodeBrainOptions,
): BrainAdapter {
  return createClaudeResidentBrain(options);
}
