import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "@/lib/db";
import { billingAllowsAi } from "@/lib/plans";
import { DEMO_ENQUIRIES, DEMO_LEADS } from "@/server/dev/seed-data";
import { seedDemo, SeedError } from "@/server/dev/seed";
import { listNeedsAttention, listPendingDrafts } from "@/server/inbox";
import { saveKnowledgeFile, getKnowledgeFiles } from "@/server/knowledge";
import { createOrganization, getOrganization } from "@/server/orgs";
import { dashboardStats, lastWeekReport } from "@/server/stats";
import { createTestDb, createUser, type TestDatabase } from "./helpers/db";
import { FakeQueue } from "./helpers/fakes";

// Wednesday 11 Nov 2026, 15:00 UTC.
const NOW = new Date("2026-11-11T15:00:00Z");

describe("demo seed", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("creates a demo business with data on every screen", async () => {
    const userId = await createUser(t.db, "fresh@example.com");
    const result = await seedDemo(t.db, { userId, now: NOW, timezone: "Europe/London" });
    expect(result).toMatchObject({
      createdOrg: true,
      markedTrial: true,
      leadsCreated: DEMO_LEADS.length,
      alreadySeeded: false,
      enquiriesQueued: 0,
    });
    expect(result.knowledgeFilled).toEqual(["voice", "services", "faqs", "booking", "banned_words"]);

    const org = (await getOrganization(t.db, result.orgId))!;
    expect(org.timezone).toBe("Europe/London");
    expect(org.onboarding_completed_at).toBeInstanceOf(Date);
    expect(billingAllowsAi(org)).toBe(true);

    // Everything is visible to the owner through RLS.
    const [pending, attention] = await asUser(t.db, userId, (tx) =>
      Promise.all([listPendingDrafts(tx, org.id), listNeedsAttention(tx, org.id)]),
    );
    expect(pending.map((p) => p.draft.kind).sort()).toEqual(["first_reply", "first_reply", "first_reply", "followup_1"]);
    // The deliberately imperfect draft shows a warning in the inbox.
    expect(pending.find((p) => p.lead.name === "Priya Shah")?.warnings).toContain("Does not include your booking link");
    expect(attention.map((a) => a.reason)).toEqual(["support"]);

    const stats = await dashboardStats(t.db, org.id, org.timezone, NOW);
    expect(stats.current.leads).toBeGreaterThan(0);
    expect(stats.current.booked).toBeGreaterThan(0);
    expect(stats.current.avgReplySeconds).toBeGreaterThan(0);
    expect(stats.current.aiCostUsd).toBeGreaterThan(0);
    expect(stats.pendingApprovals).toBe(4);

    const report = await lastWeekReport(t.db, org.id, org.timezone, NOW);
    expect(report.current.answered + report.current.booked).toBeGreaterThan(0);

    // Every demo address is on the reserved example.com domain.
    const { rows } = await t.db.query<{ email: string }>("select email from public.leads where org_id = $1", [org.id]);
    expect(rows.every((r) => r.email.endsWith("@example.com"))).toBe(true);
  });

  it("is idempotent, and --reset recreates only demo data", async () => {
    const userId = await createUser(t.db, "twice@example.com");
    const first = await seedDemo(t.db, { userId, now: NOW });
    const own = await t.db.query<{ id: string }>(
      "insert into public.leads (org_id, email, message, source) values ($1, 'real@example.com', 'real lead', 'form') returning id",
      [first.orgId],
    );

    const again = await seedDemo(t.db, { userId, now: NOW });
    expect(again).toMatchObject({ alreadySeeded: true, leadsCreated: 0, createdOrg: false });

    const reset = await seedDemo(t.db, { userId, now: NOW, reset: true });
    expect(reset).toMatchObject({ removed: DEMO_LEADS.length, leadsCreated: DEMO_LEADS.length });
    const counts = await t.db.query<{ source: string; n: number }>(
      "select source, count(*)::int as n from public.leads where org_id = $1 group by source order by source",
      [first.orgId],
    );
    expect(counts.rows).toEqual([
      { source: "demo", n: DEMO_LEADS.length },
      { source: "form", n: 1 },
    ]);
    expect(own.rows[0]).toBeDefined();
    const usage = await t.db.query<{ n: number }>(
      "select count(*)::int as n from public.llm_usage where org_id = $1",
      [first.orgId],
    );
    // Usage from the first run was removed, not doubled.
    expect(usage.rows[0]!.n).toBe(
      DEMO_LEADS.length + DEMO_LEADS.reduce((n, l) => n + (l.drafts?.length ?? 0), 0),
    );
  });

  it("fills an existing business without overwriting its knowledge or billing", async () => {
    const userId = await createUser(t.db, "existing@example.com");
    const org = await createOrganization(t.db, userId, { name: "My Real Clinic" });
    await saveKnowledgeFile(t.db, org.id, "voice", "My own voice");
    await t.db.query(
      "update public.organizations set plan = 'pro', subscription_status = 'past_due', stripe_subscription_id = 'sub_real' where id = $1",
      [org.id],
    );

    const result = await seedDemo(t.db, { userId, now: NOW });
    expect(result).toMatchObject({ createdOrg: false, markedTrial: false, orgName: "My Real Clinic" });
    expect(result.knowledgeFilled).not.toContain("voice");
    expect((await getKnowledgeFiles(t.db, org.id)).voice).toBe("My own voice");
    expect((await getOrganization(t.db, org.id))!.subscription_status).toBe("past_due");
  });

  it("--with-ai sends tricky enquiries through the real intake path", async () => {
    const userId = await createUser(t.db, "ai@example.com");
    const queue = new FakeQueue();
    await expect(seedDemo(t.db, { userId, withAi: true })).rejects.toBeInstanceOf(SeedError);

    const result = await seedDemo(t.db, { userId, now: NOW, withAi: true, queue });
    expect(result.enquiriesQueued).toBe(DEMO_ENQUIRIES.length);
    expect(queue.ofType("process_lead")).toHaveLength(DEMO_ENQUIRIES.length);
    const { rows } = await t.db.query<{ n: number }>(
      "select count(*)::int as n from public.leads where org_id = $1 and source = 'demo-ai' and status = 'new'",
      [result.orgId],
    );
    expect(rows[0]!.n).toBe(DEMO_ENQUIRIES.length);
  });
});
