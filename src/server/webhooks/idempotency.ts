import type { Db } from "@/lib/db";

/**
 * Records a webhook delivery. Returns false if this event was already
 * processed (providers retry and may deliver the same event more than once).
 */
export async function claimWebhookEvent(db: Db, source: string, eventId: string): Promise<boolean> {
  const { rows } = await db.query<{ event_id: string }>(
    `insert into internal.webhook_events (source, event_id) values ($1, $2)
     on conflict (source, event_id) do nothing returning event_id`,
    [source, eventId.slice(0, 500)],
  );
  return rows.length > 0;
}

/** Undo a claim when processing failed, so the provider's retry is handled. */
export async function releaseWebhookEvent(db: Db, source: string, eventId: string): Promise<void> {
  await db.query("delete from internal.webhook_events where source = $1 and event_id = $2", [source, eventId.slice(0, 500)]);
}
