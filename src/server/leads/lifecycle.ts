import type { Db } from "@/lib/db";
import { recordEvent } from "@/server/events";
import type { Lead } from "@/server/types";

export type StopReason = "lead_responded" | "booked" | "lost" | "manual";

/**
 * Stops all follow-ups for a lead: marks it so scheduled follow-up jobs skip,
 * and cancels follow-up drafts that have not been sent yet.
 * Returns the ids of the drafts that were cancelled.
 */
export async function stopFollowups(db: Db, orgId: string, leadId: string, reason: StopReason): Promise<string[]> {
  return db.transaction(async (tx) => {
    const updated = await tx.query<{ id: string }>(
      `update public.leads set followups_stopped_at = now()
        where id = $1 and org_id = $2 and followups_stopped_at is null
        returning id`,
      [leadId, orgId],
    );
    const cancelled = await tx.query<{ id: string }>(
      `update public.drafts set status = 'cancelled'
        where lead_id = $1 and org_id = $2
          and kind in ('followup_1', 'followup_2')
          and status in ('pending_approval', 'approved')
        returning id`,
      [leadId, orgId],
    );
    if (updated.rows.length > 0 || cancelled.rows.length > 0) {
      await recordEvent(
        tx,
        orgId,
        "followups_stopped",
        { reason, cancelled_drafts: cancelled.rows.map((r) => r.id) },
        leadId,
      );
    }
    return cancelled.rows.map((r) => r.id);
  });
}

/** The lead wrote back (e.g. replied to our email or used the form again). */
export async function markLeadResponded(
  db: Db,
  orgId: string,
  leadId: string,
  via: "form" | "web" | "telegram",
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query(
      `update public.leads set lead_responded_at = coalesce(lead_responded_at, now())
        where id = $1 and org_id = $2`,
      [leadId, orgId],
    );
    await recordEvent(tx, orgId, "lead_responded", { via }, leadId);
    return stopFollowups(tx, orgId, leadId, "lead_responded");
  });
}

export async function markLeadBooked(
  db: Db,
  orgId: string,
  leadId: string,
  booking: Record<string, unknown>,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query(
      `update public.leads set status = 'booked', booked_at = coalesce(booked_at, now())
        where id = $1 and org_id = $2`,
      [leadId, orgId],
    );
    await recordEvent(tx, orgId, "lead_booked", booking, leadId);
    return stopFollowups(tx, orgId, leadId, "booked");
  });
}

/** Owner marks a lead as lost: cancel every unsent draft and stop follow-ups. */
export async function markLeadLost(db: Db, orgId: string, leadId: string, by: string | null): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query("update public.leads set status = 'lost' where id = $1 and org_id = $2", [leadId, orgId]);
    const cancelled = await tx.query<{ id: string }>(
      `update public.drafts set status = 'cancelled'
        where lead_id = $1 and org_id = $2 and status in ('pending_approval', 'approved')
        returning id`,
      [leadId, orgId],
    );
    await recordEvent(tx, orgId, "lead_marked_lost", { by }, leadId);
    const more = await stopFollowups(tx, orgId, leadId, "lost");
    return [...cancelled.rows.map((r) => r.id), ...more];
  });
}

export async function getLead(db: Db, orgId: string, leadId: string): Promise<Lead | null> {
  const { rows } = await db.query<Lead>("select * from public.leads where id = $1 and org_id = $2", [leadId, orgId]);
  return rows[0] ?? null;
}

/** Owner answered personally (e.g. a support question): close it, no follow-ups. */
export async function markLeadHandled(db: Db, orgId: string, leadId: string, by: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `update public.leads set status = 'replied', followups_stopped_at = coalesce(followups_stopped_at, now())
        where id = $1 and org_id = $2 and status in ('new', 'drafted', 'awaiting_approval')`,
      [leadId, orgId],
    );
    await tx.query(
      `update public.drafts set status = 'cancelled'
        where lead_id = $1 and org_id = $2 and status = 'pending_approval'`,
      [leadId, orgId],
    );
    await recordEvent(tx, orgId, "lead_handled_manually", { by }, leadId);
  });
}
