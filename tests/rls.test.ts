import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "@/lib/db";
import { createOrganization, getMembershipForUser } from "@/server/orgs";
import { createTestDb, createUser, type TestDatabase } from "./helpers/db";

describe("Row Level Security: one business can never see another's data", () => {
  let t: TestDatabase;
  let userA: string;
  let userB: string;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    t = await createTestDb();
    userA = await createUser(t.db, "a@example.com");
    userB = await createUser(t.db, "b@example.com");
    orgA = (await createOrganization(t.db, userA, { name: "Org A" })).id;
    orgB = (await createOrganization(t.db, userB, { name: "Org B" })).id;

    // Seed data for both orgs with the service connection.
    for (const [orgId, label] of [
      [orgA, "A"],
      [orgB, "B"],
    ] as const) {
      const { rows } = await t.db.query<{ id: string }>(
        "insert into public.leads (org_id, email, message) values ($1, $2, $3) returning id",
        [orgId, `lead-${label}@example.com`, `Hello from lead ${label}`],
      );
      const leadId = rows[0]!.id;
      await t.db.query(
        "insert into public.drafts (lead_id, org_id, kind, body) values ($1, $2, 'first_reply', $3)",
        [leadId, orgId, `Draft for ${label}`],
      );
      await t.db.query("insert into public.knowledge_files (org_id, slug, content) values ($1, 'voice', $2)", [
        orgId,
        `Voice ${label}`,
      ]);
      await t.db.query(
        "insert into public.llm_usage (org_id, model, input_tokens, output_tokens, cost_usd) values ($1, 'm', 1, 1, 0.01)",
        [orgId],
      );
    }
  });

  afterAll(async () => {
    await t.close();
  });

  it("org A cannot read org B's leads", async () => {
    const leads = await asUser(t.db, userA, (tx) =>
      tx.query<{ org_id: string; email: string }>("select org_id, email from public.leads"),
    );
    expect(leads.rows).toHaveLength(1);
    expect(leads.rows[0]!.org_id).toBe(orgA);

    const direct = await asUser(t.db, userA, (tx) =>
      tx.query("select * from public.leads where org_id = $1", [orgB]),
    );
    expect(direct.rows).toHaveLength(0);
  });

  it("isolates every tenant table", async () => {
    for (const table of ["organizations", "memberships", "knowledge_files", "drafts", "events", "llm_usage"]) {
      const res = await asUser(t.db, userB, (tx) =>
        tx.query<{ org: string }>(
          `select ${table === "organizations" ? "id" : "org_id"}::text as org from public.${table}`,
        ),
      );
      expect(res.rows.length, table).toBeGreaterThan(0);
      expect(
        res.rows.every((r) => r.org === orgB),
        `${table} leaked another org's rows`,
      ).toBe(true);
    }
  });

  it("signed-in users cannot write directly (no billing or approval bypass)", async () => {
    await expect(
      asUser(t.db, userA, (tx) => tx.query("update public.organizations set plan = 'pro' where id = $1", [orgA])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(t.db, userA, (tx) => tx.query("update public.drafts set status = 'approved'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(t.db, userA, (tx) =>
        tx.query("insert into public.leads (org_id, email, message) values ($1, 'x@y.z', 'hi')", [orgB]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("anonymous users see nothing", async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await tx.query("set local role anon");
        return tx.query("select * from public.leads");
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("membership lookup through RLS returns the user's own org", async () => {
    const m = await asUser(t.db, userB, (tx) => getMembershipForUser(tx, userB));
    expect(m?.org.id).toBe(orgB);
    expect(m?.role).toBe("owner");
    // Asking for someone else's membership while running as user B returns nothing.
    const other = await asUser(t.db, userB, (tx) => getMembershipForUser(tx, userA));
    expect(other).toBeNull();
  });

  it("auto-send cannot be switched on (MVP rule)", async () => {
    await expect(
      t.db.query("update public.organizations set auto_send_enabled = true where id = $1", [orgA]),
    ).rejects.toThrow(/check constraint/);
  });
});
