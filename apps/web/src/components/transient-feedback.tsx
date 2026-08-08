"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TransientFeedbackTone = "error" | "success";

export interface TransientFeedbackState {
  text: string;
  tone: TransientFeedbackTone;
}

const DEFAULT_DURATION_MS = 2_800;

/**
 * Shared short-lived feedback for copy/save actions and non-blocking mutations.
 * Inline validation remains inline; this is for a completed action that should
 * briefly acknowledge the result without changing the page layout.
 */
export function useTransientFeedback(durationMs = DEFAULT_DURATION_MS) {
  const [feedback, setFeedback] = useState<TransientFeedbackState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const showFeedback = useCallback(
    (text: string, tone: TransientFeedbackTone = "success") => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setFeedback({ text, tone });
      timerRef.current = setTimeout(() => {
        setFeedback(null);
        timerRef.current = null;
      }, durationMs);
    },
    [durationMs],
  );

  const clearFeedback = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setFeedback(null);
  }, []);

  return { clearFeedback, feedback, showFeedback };
}

export function TransientFeedback({
  feedback,
}: {
  feedback: TransientFeedbackState | null;
}) {
  if (!feedback) return null;

  const isError = feedback.tone === "error";
  return (
    <div
      aria-live={isError ? "assertive" : "polite"}
      className={`transient-feedback transient-feedback--${feedback.tone}`}
      role={isError ? "alert" : "status"}
    >
      {feedback.text}
    </div>
  );
}
