import type { Db } from "@/lib/db";

/** Appends an entry to the audit log. */
export async function recordEvent(
  db: Db,
  orgId: string,
  type: string,
  payload: Record<string, unknown> = {},
  leadId: string | null = null,
): Promise<void> {
  await db.query("insert into public.events (org_id, lead_id, type, payload) values ($1, $2, $3, $4::jsonb)", [
    orgId,
    leadId,
    type,
    JSON.stringify(payload),
  ]);
}
