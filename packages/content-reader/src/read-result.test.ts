import { expect, it } from "vitest";
import { classifyDocument } from "./document-classifier.js";
import { evidenceToReadResult } from "./read-result.js";
const context = {schema_version: 1 as const, request_ref: "r", attempt_ref: "a",
  attempts: [{method: "static" as const, duration_ms: 5}], sourceKind: "generic_web" as const,
  finalUrl: "https://example.com/article", readAt: "2026-09-07T00:00:00.000Z"};
it("maps pure article evidence to bounded public ReadResult", () => {
  const evidence = classifyDocument({html: '<article><p>A controlled article.</p></article>', finalUrl: context.finalUrl, status: 200, sourceKind: "generic_web"});
  expect(evidenceToReadResult(evidence, context)).toMatchObject({outcome: "ready", temporary_text: "A controlled article.", source_kind: "generic_web", request_ref: "r"});
});
it("maps exhausted methods to pause while retaining bounded metadata", () => {
  const evidence = classifyDocument({html: '<title>Preview</title>', finalUrl: context.finalUrl, status: 200, sourceKind: "generic_web"});
  expect(evidenceToReadResult(evidence, {...context, exhausted: true})).toMatchObject({outcome: "failed", code: "evidence_insufficient", recovery: "pause", evidence_kind: "metadata_only", metadata: {title: "Preview"}});
});
