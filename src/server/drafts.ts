import type { Db } from "@/lib/db";
import type { DraftResult, PreviousEmail } from "@/lib/ai";
import { recordEvent } from "@/server/events";
import { DRAFT_COLUMNS, type Draft, type DraftKind } from "@/server/types";

export async function getDraft(db: Db, orgId: string, draftId: string): Promise<Draft | null> {
  const { rows } = await db.query<Draft>(`select ${DRAFT_COLUMNS} from public.drafts d where d.id = $1 and d.org_id = $2`, [
    draftId,
    orgId,
  ]);
  return rows[0] ?? null;
}

/**
 * Stores an AI draft as pending_approval. Returns null if a live draft of this
 * kind already exists for the lead (job retries are safe).
 */
export async function insertDraft(
  db: Db,
  orgId: string,
  leadId: string,
  kind: DraftKind,
  draft: DraftResult,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.drafts (lead_id, org_id, kind, subject, body, model)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (lead_id, kind) where status in ('pending_approval', 'approved', 'sent') do nothing
       returning id`,
      [leadId, orgId, kind, draft.subject, draft.body, draft.model],
    );
    const id = rows[0]?.id ?? null;
    if (id) {
      await recordEvent(
        tx,
        orgId,
        "draft_created",
        { draft_id: id, kind, model: draft.model, cost_usd: draft.costUsd, warnings: draft.warnings },
        leadId,
      );
    }
    return id;
  });
}

/** Emails already sent to a lead, oldest first (context for follow-ups). */
export async function sentEmailsForLead(db: Db, orgId: string, leadId: string): Promise<PreviousEmail[]> {
  const { rows } = await db.query<{ kind: DraftKind; subject: string; body: string; sent_at: Date | null }>(
    `select kind, subject, body, sent_at from public.drafts
      where org_id = $1 and lead_id = $2 and status = 'sent' order by sent_at asc nulls last`,
    [orgId, leadId],
  );
  return rows.map((r) => ({ kind: r.kind, subject: r.subject, body: r.body, sentAt: r.sent_at }));
}

/** Latest warnings recorded for a draft (from the draft_created event). */
export async function draftWarnings(db: Db, orgId: string, draftIds: string[]): Promise<Record<string, string[]>> {
  if (draftIds.length === 0) return {};
  const { rows } = await db.query<{ draft_id: string; warnings: string[] | null }>(
    `select payload->>'draft_id' as draft_id, payload->'warnings' as warnings from public.events
      where org_id = $1 and type = 'draft_created' and payload->>'draft_id' = any($2::text[])`,
    [orgId, draftIds],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) out[r.draft_id] = Array.isArray(r.warnings) ? r.warnings : [];
  return out;
}
