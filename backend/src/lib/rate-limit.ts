/**
 * In-memory sliding-window rate limiting.
 *
 * V1 is deliberately single-container (no Redis), so this resets on restart and
 * does not coordinate across instances — documented in docs/deployment.md.
 *
 * The login limiter is not optional: `Bun.password.hash` with argon2id costs
 * roughly 100 ms of CPU per attempt on typical hardware, so an unlimited login
 * route is a trivial denial-of-service vector.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the request is allowed. */
  check(key: string, now = Date.now()): boolean {
    this.sweep(now);

    const window = this.hits.get(key)?.filter((t) => now - t < this.windowMs) ?? [];
    if (window.length >= this.limit) {
      this.hits.set(key, window);
      return false;
    }

    window.push(now);
    this.hits.set(key, window);
    return true;
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const window = this.hits.get(key) ?? [];
    const oldest = window[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Drop stale keys so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      const live = times.filter((t) => now - t < this.windowMs);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }
}
