import { beforeEach, expect, test } from "vitest";

import { consume, __resetRateLimit, type RateLimitConfig } from "@/server/rate-limit";

const cfg: RateLimitConfig = { capacity: 3, refillPerSec: 1 };

beforeEach(() => __resetRateLimit());

test("allows up to capacity, then blocks with a retry hint", () => {
  const t0 = 1_000_000;
  expect(consume("ws", cfg, t0)).toMatchObject({ ok: true });
  expect(consume("ws", cfg, t0)).toMatchObject({ ok: true });
  expect(consume("ws", cfg, t0)).toMatchObject({ ok: true });

  const blocked = consume("ws", cfg, t0);
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
});

test("refills over time", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) consume("ws", cfg, t0);
  expect(consume("ws", cfg, t0).ok).toBe(false);

  // 1s later → 1 token refilled.
  expect(consume("ws", cfg, t0 + 1000).ok).toBe(true);
});

test("buckets are isolated per key (per workspace)", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) consume("brightwave", cfg, t0);
  expect(consume("brightwave", cfg, t0).ok).toBe(false);
  // A different workspace is unaffected.
  expect(consume("meridian", cfg, t0).ok).toBe(true);
});
