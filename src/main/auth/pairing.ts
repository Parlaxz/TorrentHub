import { createHash, randomBytes } from "node:crypto";
import { MemoryRateLimiter } from "./ratelimit.js";
import type { IssuedToken, TokenStore } from "./tokenStore.js";

export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

export interface PairingServiceOptions {
  codeLength?: number;
  ttlMs?: number;
  maxActiveCodes?: number;
  attemptsPerWindowPerIp?: number;
  attemptsWindowMs?: number;
  globalAttemptsPerWindow?: number;
  now?: () => number;
  randomBytesFn?: (size: number) => Buffer;
}

export type PairAttemptResult =
  | { ok: true; issued: IssuedToken }
  | {
      ok: false;
      status: number;
      error: "invalid_code" | "expired_code" | "rate_limited" | "no_active_codes";
      retryAfterMs?: number;
    };

interface PendingCode {
  codeHash: string;
  createdAt: number;
  expiresAt: number;
}

export class PairingService {
  private readonly pending = new Map<string, PendingCode>();
  private readonly now: () => number;
  private readonly randomBytesFn: (size: number) => Buffer;
  private readonly maxActiveCodes: number;
  private readonly ipLimiter: MemoryRateLimiter;
  private readonly globalLimiter: MemoryRateLimiter;

  readonly codeLength: number;
  readonly ttlMs: number;

  constructor(
    private readonly tokens: TokenStore,
    options: PairingServiceOptions = {},
  ) {
    this.codeLength = options.codeLength ?? PAIRING_CODE_LENGTH;
    this.ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.maxActiveCodes = options.maxActiveCodes ?? 5;
    this.now = options.now ?? Date.now;
    this.randomBytesFn = options.randomBytesFn ?? randomBytes;
    const windowMs = options.attemptsWindowMs ?? DEFAULT_PAIRING_TTL_MS;
    this.ipLimiter = new MemoryRateLimiter(
      { windowMs, max: options.attemptsPerWindowPerIp ?? 10 },
      this.now,
    );
    this.globalLimiter = new MemoryRateLimiter(
      { windowMs, max: options.globalAttemptsPerWindow ?? 100 },
      this.now,
    );
  }

  beginPairing(): { code: string; expiresAt: number } {
    this.prune();
    while (this.pending.size >= this.maxActiveCodes) {
      let oldestKey: string | null = null;
      let oldestCreated = Infinity;
      for (const [key, value] of this.pending) {
        if (value.createdAt < oldestCreated) {
          oldestCreated = value.createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      this.pending.delete(oldestKey);
    }
    const code = this.generateCode();
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    this.pending.set(this.hashCode(code), { codeHash: this.hashCode(code), createdAt, expiresAt });
    return { code, expiresAt };
  }

  activeCount(): number {
    this.prune();
    return this.pending.size;
  }

  attempt(rawCode: string, clientIp: string, name?: string): PairAttemptResult {
    const ip = clientIp || "unknown";
    const globalVerdict = this.globalLimiter.take("global");
    if (!globalVerdict.ok) {
      return { ok: false, status: 429, error: "rate_limited", retryAfterMs: globalVerdict.retryAfterMs };
    }
    const ipVerdict = this.ipLimiter.take(ip);
    if (!ipVerdict.ok) {
      return { ok: false, status: 429, error: "rate_limited", retryAfterMs: ipVerdict.retryAfterMs };
    }

    const normalized = String(rawCode ?? "").trim().toUpperCase();
    const key = this.hashCode(normalized);
    const entry = this.pending.get(key);
    if (!entry) {
      return { ok: false, status: 400, error: "invalid_code" };
    }
    if (this.now() >= entry.expiresAt) {
      this.pending.delete(key);
      return { ok: false, status: 410, error: "expired_code" };
    }
    this.pending.delete(key);
    const issued = this.tokens.issue(name?.trim() || "paired-client");
    return { ok: true, issued };
  }

  private generateCode(): string {
    const bytes = this.randomBytesFn(this.codeLength);
    let out = "";
    for (let i = 0; i < this.codeLength; i++) {
      out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
    }
    return out;
  }

  private hashCode(code: string): string {
    return createHash("sha256").update(code, "utf8").digest("hex");
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.pending) {
      if (now >= value.expiresAt) this.pending.delete(key);
    }
  }
}
