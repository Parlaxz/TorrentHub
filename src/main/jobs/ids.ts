import { randomUUID } from "node:crypto";

export function newJobId(): string {
  return randomUUID();
}

export function newSessionEpoch(): string {
  return randomUUID();
}

/** Normalize an idempotency key; empty/whitespace keys are treated as absent. */
export function normalizeIdempotencyKey(key: string | null | undefined): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}
