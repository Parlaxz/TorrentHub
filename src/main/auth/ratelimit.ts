export interface MemoryRateLimiterOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitVerdict {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class MemoryRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly options: MemoryRateLimiterOptions,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): RateLimitVerdict {
    const now = this.now();
    const windowStart = now - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.options.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        ok: false,
        remaining: 0,
        retryAfterMs: Math.max(oldest + this.options.windowMs - now, 1),
      };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, remaining: this.options.max - recent.length, retryAfterMs: 0 };
  }

  reset(): void {
    this.hits.clear();
  }
}
