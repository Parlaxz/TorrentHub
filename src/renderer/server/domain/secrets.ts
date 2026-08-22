/**
 * Secret display rules for Server Mode.
 *
 * Secrets (qBittorrent API key, Viking user hash) are write-only from the
 * renderer's perspective: after save, UI may only show a fixed mask or a
 * backend-provided masked hint. Plaintext can appear ONLY through an explicit
 * user-initiated reveal action backed by the bridge capability.
 */

export const SECRET_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

export type SecretDisplayState = "unset" | "saved" | "revealed";

export interface SecretDisplay {
  state: SecretDisplayState;
  /** What the input/value row should render. Never plaintext unless revealed. */
  displayValue: string;
}

export function secretDisplay(set: boolean, revealedPlaintext?: string | null): SecretDisplay {
  if (revealedPlaintext) {
    return { state: "revealed", displayValue: revealedPlaintext };
  }
  return set
    ? { state: "saved", displayValue: SECRET_MASK }
    : { state: "unset", displayValue: "" };
}

/**
 * Runtime guard: given an object that should be display-safe, throw if any
 * listed secret field carries a non-trivial plaintext string. Used in tests
 * and in dev builds to catch contract regressions early.
 */
export function assertNoPlaintextSecrets(
  source: Record<string, unknown>,
  secretFields: readonly string[],
): void {
  for (const field of secretFields) {
    const value = source[field];
    if (typeof value === "string" && value.length > 0 && value !== SECRET_MASK) {
      throw new Error(`display object leaked plaintext into secret field "${field}"`);
    }
  }
}
