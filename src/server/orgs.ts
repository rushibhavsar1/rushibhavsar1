import { z } from "zod";
import type { Db } from "@/lib/db";
import { recordEvent } from "@/server/events";
import { ORG_COLUMNS, type MemberRole, type Organization } from "@/server/types";

export const createOrganizationInput = z.object({
  name: z.string().trim().min(1, "Business name is required").max(120),
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown time zone")
    .default("UTC"),
});
export type CreateOrganizationInput = z.input<typeof createOrganizationInput>;

export class AlreadyHasOrganizationError extends Error {
  constructor() {
    super("You already have a business set up.");
  }
}

/** Creates an organization and makes `userId` its owner, atomically. */
export async function createOrganization(db: Db, userId: string, input: CreateOrganizationInput): Promise<Organization> {
  const data = createOrganizationInput.parse(input);
  return db.transaction(async (tx) => {
    const existing = await tx.query("select 1 from public.memberships where user_id = $1 limit 1", [userId]);
    if (existing.rows.length > 0) throw new AlreadyHasOrganizationError();

    const { rows } = await tx.query<{ id: string }>(
      "insert into public.organizations (name, timezone) values ($1, $2) returning id",
      [data.name, data.timezone],
    );
    const orgId = rows[0]!.id;
    await tx.query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [userId, orgId]);
    await recordEvent(tx, orgId, "org_created", { by: userId });
    const org = await getOrganization(tx, orgId);
    return org!;
  });
}

export async function getOrganization(db: Db, orgId: string): Promise<Organization | null> {
  const { rows } = await db.query<Organization>(`select ${ORG_COLUMNS} from public.organizations o where o.id = $1`, [
    orgId,
  ]);
  return rows[0] ?? null;
}

export async function getOrganizationByKey(db: Db, orgKey: string): Promise<Organization | null> {
  const { rows } = await db.query<Organization>(
    `select ${ORG_COLUMNS} from public.organizations o where o.org_key = $1`,
    [orgKey],
  );
  return rows[0] ?? null;
}

export interface Membership {
  org: Organization;
  role: MemberRole;
}

/**
 * The user's organization, read through RLS. Pass a Db that is already
 * running as the user (see asUser) — the query itself cannot see other orgs.
 */
export async function getMembershipForUser(userDb: Db, userId: string): Promise<Membership | null> {
  const { rows } = await userDb.query<Organization & { member_role: MemberRole }>(
    `select ${ORG_COLUMNS}, m.role as member_role
       from public.memberships m
       join public.organizations o on o.id = m.org_id
      where m.user_id = $1
      order by m.created_at
      limit 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const { member_role, ...org } = row;
  return { org, role: member_role };
}

/** Owner email addresses for an organization (for reports and notices). */
export async function getOwnerEmails(db: Db, orgId: string): Promise<string[]> {
  const { rows } = await db.query<{ email: string }>(
    `select u.email from public.memberships m join auth.users u on u.id = m.user_id
      where m.org_id = $1 and m.role in ('owner', 'admin') and u.email is not null
      order by m.created_at`,
    [orgId],
  );
  return rows.map((r) => r.email);
}
