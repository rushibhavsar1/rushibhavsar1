import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { JobPayloads } from "@/lib/queue";
import type { WorkerDeps } from "@/server/deps";
import { renderWeeklyReport } from "@/server/email/weekly-report";
import { recordEvent } from "@/server/events";
import { getOrganization, getOwnerEmails } from "@/server/orgs";
import { pruneRateLimits } from "@/server/rate-limit";
import { lastWeekReport } from "@/server/stats";

/**
 * Runs hourly. Queues a report for every business where it is now Monday at
 * WEEKLY_REPORT_HOUR in its own time zone (so everyone gets it at ~8am local).
 */
export async function weeklyReportFanout(deps: Pick<WorkerDeps, "db" | "queue" | "now">): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const { rows } = await deps.db.query<{ id: string; local_day: string }>(
    `select id, to_char($1::timestamptz at time zone timezone, 'YYYY-MM-DD') as local_day
       from public.organizations
      where onboarding_completed_at is not null
        and extract(isodow from $1::timestamptz at time zone timezone) = 1
        and extract(hour from $1::timestamptz at time zone timezone) = $2
      order by created_at`,
    [now.toISOString(), env().WEEKLY_REPORT_HOUR],
  );
  for (const row of rows) {
    await deps.queue.send(
      "weekly_report_org",
      { orgId: row.id, weekStart: row.local_day },
      { singletonKey: `weekly:${row.id}:${row.local_day}` },
    );
  }
  return rows.length;
}

export type WeeklyOutcome = "missing" | "not_configured" | "no_recipients" | "quiet" | "sent";

/** Emails the owner(s) a one-page summary of last week (Mon–Sun, in the org's time zone). */
export async function weeklyReportOrg(
  deps: Pick<WorkerDeps, "db" | "mailer" | "now">,
  job: JobPayloads["weekly_report_org"],
): Promise<WeeklyOutcome> {
  const org = await getOrganization(deps.db, job.orgId);
  if (!org) return "missing";
  const from = env().SYSTEM_FROM_EMAIL;
  if (!deps.mailer || !from) {
    logger.warn("weekly report skipped: RESEND_API_KEY or SYSTEM_FROM_EMAIL not set");
    return "not_configured";
  }
  const recipients = await getOwnerEmails(deps.db, org.id);
  if (recipients.length === 0) return "no_recipients";

  const report = await lastWeekReport(deps.db, org.id, org.timezone, deps.now?.() ?? new Date());
  const nothing = (s: typeof report.current) => s.leads === 0 && s.answered === 0 && s.booked === 0 && s.aiCostUsd === 0;
  if (nothing(report.current) && nothing(report.previous)) return "quiet";

  const email = renderWeeklyReport({ orgName: org.name, timezone: org.timezone, ...report });
  const weekKey = report.start.toISOString().slice(0, 10);
  for (const to of recipients) {
    await deps.mailer.send({
      from,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      idempotencyKey: `weekly-${org.id}-${weekKey}-${to}`,
    });
  }
  await recordEvent(deps.db, org.id, "weekly_report_sent", { week_start: weekKey, recipients: recipients.length });
  return "sent";
}

/** Daily housekeeping. */
export async function maintenance(deps: Pick<WorkerDeps, "db">): Promise<string> {
  await pruneRateLimits(deps.db);
  await deps.db.query("delete from internal.webhook_events where received_at < now() - interval '30 days'");
  return "ok";
}
