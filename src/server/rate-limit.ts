/**
 * Per-workspace rate limiting (stretch).
 *
 * The copilot fans out to a shared model and a shared in-process database, so
 * one tenant hammering `/api/chat` degrades the service for everyone. A token
 * bucket keyed by `workspaceId` caps each tenant's burst and sustained rate
 * independently — tenant fairness, the same isolation theme as the data layer,
 * applied to compute.
 *
 * In-memory by design: it matches the take-home's single-process PGlite model
 * and needs zero setup. The shape (one bucket per key, `consume` returns a
 * verdict) is deliberately the same one a Redis/Upstash limiter exposes, so
 * swapping the store for a distributed backend in production is a drop-in — see
 * DECISIONS.md.
 */

type Bucket = { tokens: number; updatedAt: number };

export type RateLimitVerdict =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number };

export type RateLimitConfig = {
  /** Max burst — tokens available when fully refilled. */
  capacity: number;
  /** Sustained rate — tokens added per second. */
  refillPerSec: number;
};

/** ~30 requests/minute sustained, bursts up to 30. Tune per environment. */
export const DEFAULT_LIMIT: RateLimitConfig = {
  capacity: 30,
  refillPerSec: 0.5,
};

// Survive Next dev HMR (modules re-evaluate) by stashing buckets on globalThis,
// same pattern as the PGlite client.
const globalForRL = globalThis as unknown as {
  __rlBuckets__?: Map<string, Bucket>;
};
const buckets = globalForRL.__rlBuckets__ ?? new Map<string, Bucket>();
if (process.env.NODE_ENV !== "production") globalForRL.__rlBuckets__ = buckets;

/**
 * Consume one token for `key`. Returns whether the request is allowed and how
 * long to wait if not. `now` is injectable for deterministic tests.
 */
export function consume(
  key: string,
  config: RateLimitConfig = DEFAULT_LIMIT,
  now: number = Date.now(),
): RateLimitVerdict {
  const { capacity, refillPerSec } = config;
  const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };

  // Refill based on elapsed time since we last saw this key.
  const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
  const tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);

  if (tokens < 1) {
    // Not enough for one request — report how long until a token is available.
    buckets.set(key, { tokens, updatedAt: now });
    const retryAfterMs = Math.ceil(((1 - tokens) / refillPerSec) * 1000);
    return { ok: false, retryAfterMs };
  }

  buckets.set(key, { tokens: tokens - 1, updatedAt: now });
  return { ok: true, remaining: Math.floor(tokens - 1) };
}

/** Test helper: drop all buckets. */
export function __resetRateLimit() {
  buckets.clear();
}
