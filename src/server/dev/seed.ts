/**
 * Demo data for local development (`npm run db:seed`).
 *
 * - Creates a demo business for the given user (or fills the one they have).
 * - Fills empty knowledge files, marks onboarding done and, if the org has no
 *   Stripe subscription, puts it on a Starter trial so the AI runs locally.
 * - Adds leads in every state with drafts, events and AI usage, spread over
 *   the last two weeks (inbox, leads, dashboard and weekly report all have data).
 * - Optionally sends tricky enquiries through the real intake path so the
 *   worker drafts them with Claude (`withAi`).
 *
 * All demo leads have source "demo" / "demo-ai" so `reset` removes exactly them.
 */
import { checkDraft } from "@/lib/ai";
import type { Db } from "@/lib/db";
import { KNOWLEDGE_SLUGS } from "@/lib/knowledge";
import type { Queue } from "@/lib/queue";
import { recordEvent } from "@/server/events";
import { getKnowledgeFiles, saveKnowledgeFile } from "@/server/knowledge";
import { intakeLead, leadInput } from "@/server/leads/intake";
import { createOrganization, getMembershipForUser, getOrganization } from "@/server/orgs";
import { DEMO_ENQUIRIES, DEMO_KNOWLEDGE, DEMO_LEADS, DEMO_ORG_NAME, type DemoLead } from "./seed-data";

export interface SeedOptions {
  userId: string;
  now?: Date;
  /** Delete earlier demo leads (and their drafts, events and usage) first. */
  reset?: boolean;
  /** Also queue DEMO_ENQUIRIES for real AI processing (needs a queue and a running worker). */
  withAi?: boolean;
  queue?: Queue | null;
  timezone?: string;
}

export interface SeedResult {
  orgId: string;
  orgName: string;
  createdOrg: boolean;
  markedTrial: boolean;
  knowledgeFilled: string[];
  removed: number;
  leadsCreated: number;
  draftsCreated: number;
  enquiriesQueued: number;
  alreadySeeded: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Plausible per-call costs for the demo AI usage rows. */
const DEMO_USAGE = {
  classify: { model: "claude-haiku-5-5", input: 180, cached: 1100, output: 60, cost: 0.000059 },
  draft: { model: "claude-sonnet-5-5", input: 420, cached: 1600, output: 520, cost: 0.006200 },
};

export class SeedError extends Error {}

async function insertDemoLead(db: Db, orgId: string, userId: string, lead: DemoLead, now: Date): Promise<number> {
  const created = new Date(now.getTime() - lead.hoursAgo * HOUR);
  const sentDrafts = (lead.drafts ?? []).filter((d) => d.status === "sent");
  const firstSent = sentDrafts.find((d) => d.kind === "first_reply");
  const firstRepliedAt = firstSent?.sentAfterMin !== undefined ? new Date(created.getTime() + firstSent.sentAfterMin * MIN) : null;
  const bookedAt = lead.bookedHoursAgo !== undefined ? new Date(now.getTime() - lead.bookedHoursAgo * HOUR) : null;
  const respondedAt = lead.respondedHoursAgo !== undefined ? new Date(now.getTime() - lead.respondedHoursAgo * HOUR) : null;
  const stopped = bookedAt ?? respondedAt ?? (lead.status === "lost" ? created : null);

  const { rows } = await db.query<{ id: string }>(
    `insert into public.leads
       (org_id, name, email, phone, source, message, status, classification, classification_reason,
        first_replied_at, booked_at, lead_responded_at, followups_stopped_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'demo', $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $13::timestamptz)
     returning id`,
    [
      orgId,
      lead.name,
      lead.email,
      lead.phone ?? null,
      lead.message,
      lead.status,
      lead.classification,
      lead.classificationReason,
      firstRepliedAt?.toISOString() ?? null,
      bookedAt?.toISOString() ?? null,
      respondedAt?.toISOString() ?? null,
      stopped?.toISOString() ?? null,
      created.toISOString(),
    ],
  );
  const leadId = rows[0]!.id;

  const event = (type: string, at: Date, payload: Record<string, unknown> = {}) =>
    db.query(
      "insert into public.events (org_id, lead_id, type, payload, created_at) values ($1, $2, $3, $4::jsonb, $5)",
      [orgId, leadId, type, JSON.stringify({ ...payload, demo: true }), at.toISOString()],
    );
  const usage = (kind: keyof typeof DEMO_USAGE, at: Date, purpose: string) => {
    const u = DEMO_USAGE[kind];
    return db.query(
      `insert into public.llm_usage (org_id, model, purpose, input_tokens, output_tokens, cached_tokens, cost_usd, lead_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, u.model, `demo:${purpose}`, u.input, u.output, u.cached, u.cost, leadId, at.toISOString()],
    );
  };

  await event("lead_received", created, { source: "demo" });
  const classifiedAt = new Date(created.getTime() + 20_000);
  await event("lead_classified", classifiedAt, { category: lead.classification, reason: lead.classificationReason });
  await usage("classify", classifiedAt, "classify_lead");

  let drafts = 0;
  for (const d of lead.drafts ?? []) {
    const draftedAt = new Date(created.getTime() + d.draftedAfterMin * MIN);
    const sentAt = d.status === "sent" && d.sentAfterMin !== undefined ? new Date(created.getTime() + d.sentAfterMin * MIN) : null;
    const { rows: draftRows } = await db.query<{ id: string }>(
      `insert into public.drafts
         (lead_id, org_id, kind, subject, body, status, model, approved_by, approved_at, approved_via, sent_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'claude-sonnet-5-5', $7, $8::timestamptz, $9, $8::timestamptz,
               $10::timestamptz, coalesce($8::timestamptz, $10::timestamptz))
       returning id`,
      [
        leadId,
        orgId,
        d.kind,
        d.subject,
        d.body,
        d.status,
        sentAt ? userId : null,
        sentAt?.toISOString() ?? null,
        sentAt ? "web" : null,
        draftedAt.toISOString(),
      ],
    );
    const draftId = draftRows[0]!.id;
    drafts += 1;
    await usage("draft", draftedAt, `draft_${d.kind}`);
    await event("draft_created", draftedAt, {
      draft_id: draftId,
      kind: d.kind,
      model: "claude-sonnet-5-5",
      warnings: checkDraft(d.body, DEMO_KNOWLEDGE, d.kind),
    });
    if (sentAt) {
      await event("draft_approved", sentAt, { draft_id: draftId, via: "web", by: userId, edited: false });
      await event("email_sent", new Date(sentAt.getTime() + 2000), { draft_id: draftId, kind: d.kind });
    }
    if (d.status === "rejected") {
      await event("draft_rejected", new Date(draftedAt.getTime() + 30 * MIN), { draft_id: draftId, via: "web" });
    }
  }

  if (lead.classification === "lead" && lead.status === "lost") {
    await event("lead_marked_lost", new Date(created.getTime() + 2 * HOUR), { by: userId });
  }
  if (respondedAt) {
    await event("lead_responded", respondedAt, { via: "web" });
    await event("followups_stopped", respondedAt, { reason: "lead_responded" });
  }
  if (bookedAt) {
    await event("lead_booked", bookedAt, { trigger: "BOOKING_CREATED", uid: `demo-${lead.key}` });
    await event("followups_stopped", bookedAt, { reason: "booked" });
  }
  return drafts;
}

export async function seedDemo(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  if (opts.withAi && !opts.queue) throw new SeedError("withAi needs a job queue");

  // 1. The user's business (or a new demo one).
  const membership = await getMembershipForUser(db, opts.userId);
  let createdOrg = false;
  let orgId: string;
  if (membership) {
    orgId = membership.org.id;
  } else {
    orgId = (await createOrganization(db, opts.userId, { name: DEMO_ORG_NAME, timezone: opts.timezone ?? "UTC" })).id;
    createdOrg = true;
  }

  // 2. Optional reset of earlier demo data.
  let removed = 0;
  if (opts.reset) {
    const del = await db.query<{ id: string }>(
      "delete from public.leads where org_id = $1 and source in ('demo', 'demo-ai') returning id",
      [orgId],
    );
    removed = del.rows.length;
    await db.query("delete from public.llm_usage where org_id = $1 and purpose like 'demo:%'", [orgId]);
  }

  // 3. Org setup: onboarding done; Starter trial if not billed through Stripe.
  await db.query(
    "update public.organizations set onboarding_completed_at = coalesce(onboarding_completed_at, $2) where id = $1",
    [orgId, now.toISOString()],
  );
  const trial = await db.query<{ id: string }>(
    `update public.organizations
        set plan = 'starter', subscription_status = 'trialing'
      where id = $1 and stripe_subscription_id is null and plan = 'none'
      returning id`,
    [orgId],
  );

  // 4. Knowledge files: fill only the empty ones (never overwrite the owner's).
  const existing = await getKnowledgeFiles(db, orgId);
  const knowledgeFilled: string[] = [];
  for (const slug of KNOWLEDGE_SLUGS) {
    if (!existing[slug]?.trim()) {
      await saveKnowledgeFile(db, orgId, slug, DEMO_KNOWLEDGE[slug]);
      knowledgeFilled.push(slug);
    }
  }

  // 5. Leads, drafts, events and usage (once per org unless reset).
  const already = await db.query<{ n: number }>(
    "select count(*)::int as n from public.leads where org_id = $1 and source = 'demo'",
    [orgId],
  );
  const alreadySeeded = (already.rows[0]?.n ?? 0) > 0;
  let leadsCreated = 0;
  let draftsCreated = 0;
  if (!alreadySeeded) {
    await db.transaction(async (tx) => {
      for (const lead of DEMO_LEADS) {
        draftsCreated += await insertDemoLead(tx, orgId, opts.userId, lead, now);
        leadsCreated += 1;
      }
      await recordEvent(tx, orgId, "demo_seeded", { leads: leadsCreated });
    });
  }

  // 6. Tricky enquiries through the real pipeline.
  let enquiriesQueued = 0;
  if (opts.withAi && opts.queue) {
    const org = (await getOrganization(db, orgId))!;
    for (const e of DEMO_ENQUIRIES) {
      const result = await intakeLead({ db, queue: opts.queue }, org, leadInput.parse({ ...e, source: "demo-ai" }));
      if (result.status === "accepted" && result.queued) enquiriesQueued += 1;
    }
  }

  const org = (await getOrganization(db, orgId))!;
  return {
    orgId,
    orgName: org.name,
    createdOrg,
    markedTrial: trial.rows.length > 0,
    knowledgeFilled,
    removed,
    leadsCreated,
    draftsCreated,
    enquiriesQueued,
    alreadySeeded,
  };
}
