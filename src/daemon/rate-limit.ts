/**
 * Token-bucket rate limiter keyed by caller. Each key may make `burst`
 * calls at once and refills at `perSecond`. A limit of 0 disables it.
 */
export class RateLimiter {
    private buckets = new Map<string, { tokens: number; updated: number }>();
    private lastSweep = 0;

    constructor(
        private readonly perSecond: number,
        private readonly burst: number,
        private readonly now: () => number = Date.now
    ) { }

    get enabled(): boolean {
        return this.perSecond > 0 && this.burst > 0;
    }

    /** Take one token for `key`. Returns 0 when allowed, otherwise seconds until a token is available. */
    take(key: string): number {
        if (!this.enabled) return 0;
        const t = this.now();
        this.sweep(t);
        const b = this.buckets.get(key) ?? { tokens: this.burst, updated: t };
        b.tokens = Math.min(this.burst, b.tokens + ((t - b.updated) / 1000) * this.perSecond);
        b.updated = t;
        this.buckets.set(key, b);
        if (b.tokens >= 1) {
            b.tokens -= 1;
            return 0;
        }
        return Math.max(1, Math.ceil((1 - b.tokens) / this.perSecond));
    }

    /** Drop buckets that have refilled completely, so ids that stop calling do not accumulate. */
    private sweep(t: number) {
        if (t - this.lastSweep < 60_000) return;
        this.lastSweep = t;
        const fullAfterMs = (this.burst / this.perSecond) * 1000;
        for (const [key, b] of this.buckets) {
            if (t - b.updated >= fullAfterMs) this.buckets.delete(key);
        }
    }
}

export type RateLimitConfig = { perSecond: number; burst: number };

/** Per-instance limit from NEXUS_RATE_LIMIT (calls/s, 0 disables) and NEXUS_RATE_BURST. */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
    const num = (v: string | undefined, d: number) => {
        const n = Number(v);
        return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
    };
    return { perSecond: num(env.NEXUS_RATE_LIMIT, 20), burst: num(env.NEXUS_RATE_BURST, 60) };
}

/**
 * Instance ids are self-declared, so a client could rotate them to dodge the
 * per-instance limit; every request is also counted per client address at
 * this multiple of the per-instance limit.
 */
export const ADDRESS_LIMIT_FACTOR = 5;
