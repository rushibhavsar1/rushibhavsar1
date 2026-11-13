import type { Db } from "@/lib/db";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limit stored in Postgres, so it holds across restarts and
 * multiple web instances. One round trip per check.
 */
export async function hitRateLimit(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const { rows } = await db.query<{ count: number }>(
    `insert into internal.rate_limits (key, window_start, count) values ($1, $2, 1)
     on conflict (key, window_start) do update set count = internal.rate_limits.count + 1
     returning count`,
    [key, windowStart.toISOString()],
  );
  const count = Number(rows[0]?.count ?? 0);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
  return { allowed: count <= limit, count, limit, retryAfterSeconds };
}

/** Removes expired windows. Called periodically by the worker. */
export async function pruneRateLimits(db: Db, olderThanSeconds = 86_400): Promise<void> {
  await db.query("delete from internal.rate_limits where window_start < now() - make_interval(secs => $1)", [
    olderThanSeconds,
  ]);
}
