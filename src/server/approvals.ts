import { z } from "zod";
import type { Db } from "@/lib/db";
import type { Queue } from "@/lib/queue";
import { recordEvent } from "@/server/events";
import { DRAFT_COLUMNS, type Draft } from "@/server/types";

export type Actor = { via: "web"; userId: string } | { via: "telegram"; chatId: string };

export const draftEditInput = z.object({
  subject: z
    .string()
    .transform((v) => v.replace(/[\r\n]+/g, " ").trim())
    .pipe(z.string().min(1, "Subject is required").max(200)),
  body: z
    .string()
    .transform((v) => v.replace(/\r\n/g, "\n").trim())
    .pipe(z.string().min(1, "The email can't be empty").max(20000)),
});
export type DraftEdit = z.infer<typeof draftEditInput>;

export class DraftNotPendingError extends Error {
  constructor() {
    super("This draft was already handled.");
  }
}

function actorFields(actor: Actor) {
  return {
    userId: actor.via === "web" ? actor.userId : null,
    payload: actor.via === "web" ? { by: actor.userId, via: "web" } : { chat_id: actor.chatId, via: "telegram" },
  };
}

/**
 * Owner approves a draft (optionally with edits). Only a pending draft can be
 * approved, and only approval enqueues sending — this is the single path to
 * sending an email.
 */
export async function approveDraft(
  deps: { db: Db; queue: Queue },
  orgId: string,
  draftId: string,
  actor: Actor,
  edit?: DraftEdit,
): Promise<Draft> {
  const { userId, payload } = actorFields(actor);
  const draft = await deps.db.transaction(async (tx) => {
    const { rows } = await tx.query<Draft>(
      `update public.drafts d
          set status = 'approved', approved_at = now(), approved_by = $3, approved_via = $4,
              subject = coalesce($5, d.subject), body = coalesce($6, d.body)
        where d.id = $1 and d.org_id = $2 and d.status = 'pending_approval'
          and not exists (
            select 1 from public.leads l
             where l.id = d.lead_id and d.kind <> 'first_reply' and l.followups_stopped_at is not null
          )
        returning ${DRAFT_COLUMNS}`,
      [draftId, orgId, userId, actor.via, edit?.subject ?? null, edit?.body ?? null],
    );
    const row = rows[0];
    if (!row) throw new DraftNotPendingError();
    await recordEvent(tx, orgId, "draft_approved", { ...payload, draft_id: draftId, edited: Boolean(edit) }, row.lead_id);
    return row;
  });
  await deps.queue.send("send_draft", { draftId, orgId }, { singletonKey: `send:${draftId}` });
  return draft;
}

/** Owner rejects a draft. A rejected first reply puts the lead back to "new". */
export async function rejectDraft(db: Db, orgId: string, draftId: string, actor: Actor): Promise<Draft> {
  const { payload } = actorFields(actor);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Draft>(
      `update public.drafts d set status = 'rejected'
        where d.id = $1 and d.org_id = $2 and d.status = 'pending_approval'
        returning ${DRAFT_COLUMNS}`,
      [draftId, orgId],
    );
    const row = rows[0];
    if (!row) throw new DraftNotPendingError();
    if (row.kind === "first_reply") {
      await tx.query(
        "update public.leads set status = 'new' where id = $1 and org_id = $2 and status in ('drafted', 'awaiting_approval')",
        [row.lead_id, orgId],
      );
    }
    await recordEvent(tx, orgId, "draft_rejected", { ...payload, draft_id: draftId }, row.lead_id);
    return row;
  });
}

/** Saves edits to a pending draft without approving it. */
export async function editDraft(db: Db, orgId: string, draftId: string, actor: Actor, edit: DraftEdit): Promise<Draft> {
  const { payload } = actorFields(actor);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Draft>(
      `update public.drafts d set subject = $3, body = $4
        where d.id = $1 and d.org_id = $2 and d.status = 'pending_approval'
        returning ${DRAFT_COLUMNS}`,
      [draftId, orgId, edit.subject, edit.body],
    );
    const row = rows[0];
    if (!row) throw new DraftNotPendingError();
    await recordEvent(tx, orgId, "draft_edited", { ...payload, draft_id: draftId }, row.lead_id);
    return row;
  });
}

/** Asks the AI for a fresh first reply (after a rejection). */
export async function requestNewDraft(deps: { db: Db; queue: Queue }, orgId: string, leadId: string): Promise<boolean> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select l.id from public.leads l
      where l.id = $1 and l.org_id = $2 and l.status = 'new'
        and not exists (
          select 1 from public.drafts d
           where d.lead_id = l.id and d.kind = 'first_reply' and d.status in ('pending_approval', 'approved', 'sent')
        )`,
    [leadId, orgId],
  );
  if (rows.length === 0) return false;
  await recordEvent(deps.db, orgId, "redraft_requested", {}, leadId);
  await deps.queue.send("process_lead", { leadId, orgId }, { singletonKey: `process_lead:${leadId}:${Date.now()}` });
  return true;
}
