import type { Db } from "@/lib/db";
import { draftWarnings } from "@/server/drafts";
import type { Draft, Lead, LeadStatus } from "@/server/types";

export interface PendingItem {
  draft: Pick<Draft, "id" | "kind" | "subject" | "body" | "model" | "created_at">;
  lead: Pick<Lead, "id" | "name" | "email" | "phone" | "message" | "source" | "created_at">;
  warnings: string[];
}

/** Drafts waiting for approval, oldest first, each with the original lead message. */
export async function listPendingDrafts(db: Db, orgId: string): Promise<PendingItem[]> {
  const { rows } = await db.query<{
    draft_id: string;
    kind: Draft["kind"];
    subject: string;
    body: string;
    model: string | null;
    draft_created_at: Date;
    lead_id: string;
    name: string | null;
    email: string;
    phone: string | null;
    message: string;
    source: string;
    lead_created_at: Date;
  }>(
    `select d.id as draft_id, d.kind, d.subject, d.body, d.model, d.created_at as draft_created_at,
            l.id as lead_id, l.name, l.email, l.phone, l.message, l.source, l.created_at as lead_created_at
       from public.drafts d join public.leads l on l.id = d.lead_id
      where d.org_id = $1 and d.status = 'pending_approval'
      order by d.created_at asc
      limit 100`,
    [orgId],
  );
  const warnings = await draftWarnings(
    db,
    orgId,
    rows.map((r) => r.draft_id),
  );
  return rows.map((r) => ({
    draft: {
      id: r.draft_id,
      kind: r.kind,
      subject: r.subject,
      body: r.body,
      model: r.model,
      created_at: r.draft_created_at,
    },
    lead: {
      id: r.lead_id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      message: r.message,
      source: r.source,
      created_at: r.lead_created_at,
    },
    warnings: warnings[r.draft_id] ?? [],
  }));
}

export interface AttentionItem {
  lead: Pick<Lead, "id" | "name" | "email" | "phone" | "message" | "classification" | "created_at">;
  reason: "support" | "ai_blocked" | "ai_refused" | "rejected" | "waiting";
  detail: string | null;
}

/** New leads without a pending draft: support questions, AI blocked, rejected drafts. */
export async function listNeedsAttention(db: Db, orgId: string): Promise<AttentionItem[]> {
  const { rows } = await db.query<{
    id: string;
    name: string | null;
    email: string;
    phone: string | null;
    message: string;
    classification: Lead["classification"];
    created_at: Date;
    last_type: string | null;
    last_reason: string | null;
  }>(
    `select l.id, l.name, l.email, l.phone, l.message, l.classification, l.created_at,
            e.type as last_type, e.payload->>'reason' as last_reason
       from public.leads l
       left join lateral (
         select type, payload from public.events
          where lead_id = l.id and type in ('ai_blocked', 'ai_skipped', 'ai_refused', 'draft_rejected')
          order by created_at desc limit 1
       ) e on true
      where l.org_id = $1 and l.status = 'new'
        and not exists (select 1 from public.drafts d where d.lead_id = l.id and d.status = 'pending_approval')
        and l.created_at > now() - interval '30 days'
      order by l.created_at desc
      limit 100`,
    [orgId],
  );
  return rows.map((r) => {
    let reason: AttentionItem["reason"] = "waiting";
    if (r.classification === "support") reason = "support";
    else if (r.last_type === "ai_blocked" || r.last_type === "ai_skipped") reason = "ai_blocked";
    else if (r.last_type === "ai_refused") reason = "ai_refused";
    else if (r.last_type === "draft_rejected") reason = "rejected";
    return {
      lead: {
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        message: r.message,
        classification: r.classification,
        created_at: r.created_at,
      },
      reason,
      detail: r.last_reason,
    };
  });
}

export async function listLeads(
  db: Db,
  orgId: string,
  opts: { status?: LeadStatus; limit?: number; offset?: number } = {},
): Promise<Lead[]> {
  const { rows } = await db.query<Lead>(
    `select * from public.leads
      where org_id = $1 and ($2::text is null or status = $2)
      order by created_at desc limit $3 offset $4`,
    [orgId, opts.status ?? null, opts.limit ?? 50, opts.offset ?? 0],
  );
  return rows;
}

export async function leadDetail(db: Db, orgId: string, leadId: string) {
  const lead = await db.query<Lead>("select * from public.leads where id = $1 and org_id = $2", [leadId, orgId]);
  if (!lead.rows[0]) return null;
  const drafts = await db.query<Draft>(
    `select id, lead_id, org_id, kind, subject, body, status, model, approved_by, approved_at, approved_via,
            sent_at, resend_email_id, send_error, telegram_message_id::text as telegram_message_id, created_at, updated_at
       from public.drafts where lead_id = $1 and org_id = $2 order by created_at`,
    [leadId, orgId],
  );
  const events = await db.query<{ id: string; type: string; payload: Record<string, unknown>; created_at: Date }>(
    "select id, type, payload, created_at from public.events where lead_id = $1 and org_id = $2 order by created_at",
    [leadId, orgId],
  );
  return { lead: lead.rows[0], drafts: drafts.rows, events: events.rows };
}
