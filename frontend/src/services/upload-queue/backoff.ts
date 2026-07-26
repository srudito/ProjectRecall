// Exponential backoff calculator for the upload queue.
//
// delay(attempt) = min(maxDelay, initial * factor^(attempt-1)) with optional
// symmetric jitter. Pure function — no timers.
//
// Attempts are 1-indexed. attempt <= 0 returns 0.

import { uploadRetry } from "@/src/config/limits";

export interface BackoffOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitterRatio?: number;
  random?: () => number;
}

export const nextBackoffMs = (attempt: number, opts: BackoffOptions = {}): number => {
  if (attempt <= 0) return 0;
  const initial = opts.initialDelayMs ?? uploadRetry.initialDelayMs;
  const max = opts.maxDelayMs ?? uploadRetry.maxDelayMs;
  const factor = opts.backoffFactor ?? uploadRetry.backoffFactor;
  const jitter = opts.jitterRatio ?? uploadRetry.jitterRatio;
  const random = opts.random ?? Math.random;

  const raw = Math.min(max, initial * Math.pow(factor, attempt - 1));
  if (jitter <= 0) return Math.round(raw);
  // Symmetric jitter: raw * (1 + [-jitter, +jitter])
  const factorJitter = 1 + (random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(raw * factorJitter));
};

export const shouldGiveUp = (attempt: number, maxAttempts: number = uploadRetry.maxAttempts): boolean =>
  attempt >= maxAttempts;

// Deterministic idempotency key derived from stable identifiers.
export const buildIdempotencyKey = (parts: readonly (string | number)[]): string => {
  return parts.map((p) => String(p)).join(":");
};
