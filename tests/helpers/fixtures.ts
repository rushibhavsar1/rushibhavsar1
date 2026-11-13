import type { Db } from "@/lib/db";
import { createOrganization, getOrganization } from "@/server/orgs";
import type { Organization, PlanId, SubscriptionStatus } from "@/server/types";
import { createUser } from "./db";

let counter = 0;

/** Creates an owner + organization, optionally on a paid plan. */
export async function createOrgFixture(
  db: Db,
  opts: { plan?: PlanId; status?: SubscriptionStatus; name?: string } = {},
): Promise<{ org: Organization; userId: string }> {
  counter += 1;
  const userId = await createUser(db, `owner${counter}-${Date.now()}@example.com`);
  const created = await createOrganization(db, userId, { name: opts.name ?? `Org ${counter}` });
  await db.query("update public.organizations set plan = $2, subscription_status = $3 where id = $1", [
    created.id,
    opts.plan ?? "starter",
    opts.status ?? "active",
  ]);
  const org = (await getOrganization(db, created.id))!;
  return { org, userId };
}

export async function insertLead(
  db: Db,
  orgId: string,
  overrides: Partial<{ email: string; name: string; message: string; status: string }> = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.leads (org_id, name, email, message, status)
     values ($1, $2, $3, $4, coalesce($5, 'new')) returning id`,
    [
      orgId,
      overrides.name ?? "Jane Doe",
      overrides.email ?? "jane@example.com",
      overrides.message ?? "Hi! How much is teeth whitening and do you have time next week?",
      overrides.status ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function insertDraft(
  db: Db,
  orgId: string,
  leadId: string,
  overrides: Partial<{ kind: string; status: string; subject: string; body: string }> = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.drafts (lead_id, org_id, kind, subject, body, status, model)
     values ($1, $2, $3, $4, $5, $6, 'claude-sonnet-5-5') returning id`,
    [
      leadId,
      orgId,
      overrides.kind ?? "first_reply",
      overrides.subject ?? "Teeth whitening next week",
      overrides.body ?? "Hi Jane, book here: https://cal.com/brightsmile/intro",
      overrides.status ?? "pending_approval",
    ],
  );
  return rows[0]!.id;
}
