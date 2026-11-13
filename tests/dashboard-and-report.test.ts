import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { compare } from "@/components/stat-tile";
import { maintenance, weeklyReportFanout, weeklyReportOrg } from "@/server/jobs/weekly-report";
import { dashboardStats, lastWeekReport, periodStats, weekStart } from "@/server/stats";
import type { Organization } from "@/server/types";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { FakeMailer, FakeQueue } from "./helpers/fakes";
import { createOrgFixture } from "./helpers/fixtures";

// Wednesday 11 Nov 2026, 15:00 UTC. The ISO week started Monday 9 Nov.
const NOW = new Date("2026-11-11T15:00:00Z");

async function addLead(
  t: TestDatabase,
  orgId: string,
  v: { created: string; replied?: string; booked?: string; classification?: string; email?: string },
) {
  await t.db.query(
    `insert into public.leads (org_id, email, message, status, classification, created_at, first_replied_at, booked_at)
     values ($1, $2, 'hi', $3, $4, $5, $6, $7)`,
    [
      orgId,
      v.email ?? `l${Math.random()}@example.com`,
      v.booked ? "booked" : v.replied ? "replied" : "new",
      v.classification ?? "lead",
      v.created,
      v.replied ?? null,
      v.booked ?? null,
    ],
  );
}

describe("dashboard stats", () => {
  let t: TestDatabase;
  let org: Organization;

  beforeAll(async () => {
    t = await createTestDb();
    org = (await createOrgFixture(t.db)).org;
    // This week (from Mon 9 Nov): 3 real leads + 1 spam.
    await addLead(t, org.id, { created: "2026-11-10T09:00:00Z", replied: "2026-11-10T09:02:00Z", booked: "2026-11-11T10:00:00Z" });
    await addLead(t, org.id, { created: "2026-11-10T10:00:00Z", replied: "2026-11-10T10:06:00Z" });
    await addLead(t, org.id, { created: "2026-11-11T08:00:00Z" });
    await addLead(t, org.id, { created: "2026-11-11T08:30:00Z", classification: "spam" });
    // Last week.
    await addLead(t, org.id, { created: "2026-11-04T09:00:00Z", replied: "2026-11-04T09:30:00Z" });
    await t.db.query(
      `insert into public.llm_usage (org_id, model, cost_usd, created_at) values
         ($1, 'claude-sonnet-5-5', 0.25, '2026-11-10T09:01:00Z'),
         ($1, 'claude-haiku-5-5', 0.01, '2026-11-11T08:00:00Z'),
         ($1, 'claude-sonnet-5-5', 9.00, '2026-11-01T09:00:00Z')`,
      [org.id],
    );
  });
  afterAll(() => t.close());

  it("computes the week start in the org's time zone", async () => {
    expect((await weekStart(t.db, "UTC", NOW)).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect((await weekStart(t.db, "America/New_York", NOW)).toISOString()).toBe("2026-11-09T05:00:00.000Z");
  });

  it("leads this week, average reply time, calls booked and AI cost", async () => {
    const { current, previous } = await dashboardStats(t.db, org.id, "UTC", NOW);
    expect(current).toEqual({ leads: 3, answered: 2, avgReplySeconds: 240, booked: 1, aiCostUsd: 0.26 });
    // Compared with the same span last week (Mon 2 Nov 00:00 → Wed 4 Nov 15:00).
    expect(previous).toMatchObject({ leads: 1, answered: 1, avgReplySeconds: 1800, booked: 0 });
  });

  it("orders deltas by whether up is good", () => {
    expect(compare(240, 1800, { upIsGood: false, format: String, period: "last week", words: ["slower", "faster"] })).toEqual({
      text: "1560 faster than last week",
      direction: "down",
      good: true,
    });
    expect(compare(3, 3, { upIsGood: true, format: String, period: "last week" })?.direction).toBe("flat");
  });

  it("covers a full Mon–Sun week for the report", async () => {
    const monday = new Date("2026-11-16T08:00:00Z");
    const report = await lastWeekReport(t.db, org.id, "UTC", monday);
    expect(report.start.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(report.end.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(report.current.leads).toBe(3);
    const empty = await periodStats(t.db, org.id, new Date("2020-01-01"), new Date("2020-01-02"));
    expect(empty).toEqual({ leads: 0, answered: 0, avgReplySeconds: null, booked: 0, aiCostUsd: 0 });
  });
});

describe("weekly report job", () => {
  let t: TestDatabase;
  let la: Organization;
  let london: Organization;
  const queue = new FakeQueue();
  const mailer = new FakeMailer();
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.SYSTEM_FROM_EMAIL = "DeskPilot <reports@deskpilot.test>";
    process.env.WEEKLY_REPORT_HOUR = "8";
    resetEnvCache();
    t = await createTestDb();
    la = (await createOrgFixture(t.db, { name: "LA Dental" })).org;
    london = (await createOrgFixture(t.db, { name: "London <Dental>" })).org;
    await t.db.query(
      "update public.organizations set onboarding_completed_at = now(), timezone = 'America/Los_Angeles' where id = $1",
      [la.id],
    );
    await t.db.query(
      "update public.organizations set onboarding_completed_at = now(), timezone = 'Europe/London' where id = $1",
      [london.id],
    );
    await addLead(t, london.id, { created: "2026-11-10T09:00:00Z", replied: "2026-11-10T09:03:00Z", booked: "2026-11-12T09:00:00Z" });
  });
  afterAll(async () => {
    process.env = saved;
    resetEnvCache();
    await t.close();
  });
  beforeEach(() => {
    queue.clear();
    mailer.sent = [];
  });

  it("queues each business at 8am Monday in its own time zone", async () => {
    // Monday 16 Nov, 08:05 in London = 08:05 UTC; in LA it's 00:05.
    expect(await weeklyReportFanout({ db: t.db, queue, now: () => new Date("2026-11-16T08:05:00Z") })).toBe(1);
    expect(queue.ofType("weekly_report_org")[0]!.data).toEqual({ orgId: london.id, weekStart: "2026-11-16" });
    queue.clear();
    // 16:05 UTC = 08:05 in LA.
    expect(await weeklyReportFanout({ db: t.db, queue, now: () => new Date("2026-11-16T16:05:00Z") })).toBe(1);
    expect(queue.ofType("weekly_report_org")[0]!.data.orgId).toBe(la.id);
    queue.clear();
    // Not Monday: nothing.
    expect(await weeklyReportFanout({ db: t.db, queue, now: () => new Date("2026-11-17T08:05:00Z") })).toBe(0);
  });

  it("emails the owner a one-page summary of last week", async () => {
    const result = await weeklyReportOrg(
      { db: t.db, mailer, now: () => new Date("2026-11-16T08:05:00Z") },
      { orgId: london.id, weekStart: "2026-11-16" },
    );
    expect(result).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0]!;
    expect(email.from).toBe("DeskPilot <reports@deskpilot.test>");
    expect(email.to).toMatch(/@example\.com$/);
    expect(email.subject).toContain("1 leads answered, 1 calls booked");
    expect(email.html).toContain("London &lt;Dental&gt;");
    expect(email.html).toContain("3 min");
    expect(email.text).toContain("Calls booked: 1");
    expect(email.idempotencyKey).toContain(london.id);
  });

  it("skips quiet weeks", async () => {
    expect(
      await weeklyReportOrg({ db: t.db, mailer, now: () => new Date("2026-11-16T16:05:00Z") }, { orgId: la.id, weekStart: "2026-11-16" }),
    ).toBe("quiet");
    expect(mailer.sent).toHaveLength(0);
  });

  it("maintenance prunes old rate-limit windows", async () => {
    await t.db.query("insert into internal.rate_limits (key, window_start, count) values ('old', now() - interval '3 days', 1), ('new', now(), 1)");
    await maintenance({ db: t.db });
    const { rows } = await t.db.query<{ key: string }>("select key from internal.rate_limits");
    expect(rows.map((r) => r.key)).toEqual(["new"]);
  });
});
