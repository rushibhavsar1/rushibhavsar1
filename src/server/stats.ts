import type { Db } from "@/lib/db";

export interface PeriodStats {
  /** Real leads received (spam excluded). */
  leads: number;
  /** Leads that got their first reply in the period. */
  answered: number;
  /** Average seconds from lead arriving to first reply being sent. */
  avgReplySeconds: number | null;
  /** Calls booked in the period. */
  booked: number;
  /** Anthropic spend in the period (USD). */
  aiCostUsd: number;
}

/** Start of the ISO week (Monday 00:00) containing `at`, in the org's time zone. */
export async function weekStart(db: Db, timezone: string, at: Date): Promise<Date> {
  const { rows } = await db.query<{ start: Date }>(
    "select (date_trunc('week', $1::timestamptz at time zone $2) at time zone $2) as start",
    [at.toISOString(), timezone],
  );
  return new Date(rows[0]!.start);
}

export async function periodStats(db: Db, orgId: string, start: Date, end: Date): Promise<PeriodStats> {
  const { rows } = await db.query<{
    leads: number;
    answered: number;
    avg_reply: number | null;
    booked: number;
    ai_cost: number;
  }>(
    `select
       (select count(*)::int from public.leads
         where org_id = $1 and created_at >= $2 and created_at < $3
           and coalesce(classification, 'lead') <> 'spam') as leads,
       (select count(*)::int from public.leads
         where org_id = $1 and first_replied_at >= $2 and first_replied_at < $3) as answered,
       (select extract(epoch from avg(first_replied_at - created_at))::float8 from public.leads
         where org_id = $1 and first_replied_at >= $2 and first_replied_at < $3) as avg_reply,
       (select count(*)::int from public.leads
         where org_id = $1 and booked_at >= $2 and booked_at < $3) as booked,
       (select coalesce(sum(cost_usd), 0)::float8 from public.llm_usage
         where org_id = $1 and created_at >= $2 and created_at < $3) as ai_cost`,
    [orgId, start.toISOString(), end.toISOString()],
  );
  const r = rows[0]!;
  return {
    leads: r.leads,
    answered: r.answered,
    avgReplySeconds: r.avg_reply === null ? null : Number(r.avg_reply),
    booked: r.booked,
    aiCostUsd: Number(r.ai_cost),
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** This week so far vs the same span of last week (fair comparison mid-week). */
export async function dashboardStats(db: Db, orgId: string, timezone: string, now: Date = new Date()) {
  const start = await weekStart(db, timezone, now);
  const elapsed = now.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - WEEK_MS);
  const [current, previous] = await Promise.all([
    periodStats(db, orgId, start, now),
    periodStats(db, orgId, prevStart, new Date(prevStart.getTime() + elapsed)),
  ]);
  const pending = await db.query<{ n: number }>(
    "select count(*)::int as n from public.drafts where org_id = $1 and status = 'pending_approval'",
    [orgId],
  );
  return { start, current, previous, pendingApprovals: pending.rows[0]?.n ?? 0 };
}

/** The last complete week (Mon–Sun) before `now`, and the week before it. */
export async function lastWeekReport(db: Db, orgId: string, timezone: string, now: Date = new Date()) {
  const thisWeek = await weekStart(db, timezone, now);
  const start = new Date(thisWeek.getTime() - WEEK_MS);
  const prevStart = new Date(start.getTime() - WEEK_MS);
  const [current, previous] = await Promise.all([
    periodStats(db, orgId, start, thisWeek),
    periodStats(db, orgId, prevStart, start),
  ]);
  return { start, end: thisWeek, current, previous };
}
