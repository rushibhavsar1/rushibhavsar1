import { z } from "zod";
import type { Db } from "@/lib/db";
import { billingAllowsAi } from "@/lib/plans";
import type { Queue } from "@/lib/queue";
import { recordEvent } from "@/server/events";
import { markLeadResponded } from "@/server/leads/lifecycle";
import type { Organization } from "@/server/types";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** Public lead payload (website widget, Zapier, other webhooks). */
export const leadInput = z.object({
  name: optionalText(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address").max(254)),
  phone: optionalText(40).refine((v) => v === undefined || /^[0-9+().\-\s]{5,40}$/.test(v), "Invalid phone number"),
  message: z.string().trim().min(1, "Please write a message").max(5000, "Message is too long"),
  source: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{1,40}$/)
    .optional()
    .default("form"),
  /** Honeypot: humans never fill this hidden field. */
  website: z.string().max(500).optional(),
});
export type LeadInput = z.input<typeof leadInput>;

export type IntakeResult =
  | { status: "accepted"; leadId: string; queued: boolean; reason?: "unpaid" }
  | { status: "ignored" };

/**
 * Leads that count toward the plan's monthly limit: real leads (classified
 * "lead" by the AI) this calendar month. Spam and junk never use up the quota.
 */
export async function countLeadsThisMonth(db: Db, orgId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.leads
      where org_id = $1 and classification = 'lead' and created_at >= date_trunc('month', now())`,
    [orgId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Saves a new lead and enqueues AI processing.
 *
 * If the same person already has an open conversation (we replied and are
 * waiting), their new message counts as a response: follow-ups to the old
 * lead stop so they don't get nudged after writing back.
 */
export async function intakeLead(
  deps: { db: Db; queue: Queue },
  org: Organization,
  input: z.output<typeof leadInput>,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<IntakeResult> {
  if (input.website && input.website.trim() !== "") return { status: "ignored" };

  const { db, queue } = deps;
  const leadId = await db.transaction(async (tx) => {
    const previous = await tx.query<{ id: string }>(
      `select id from public.leads
        where org_id = $1 and lower(email) = $2
          and status = 'replied' and followups_stopped_at is null
        order by created_at desc limit 5`,
      [org.id, input.email],
    );
    for (const row of previous.rows) {
      await markLeadResponded(tx, org.id, row.id, "form");
    }

    const { rows } = await tx.query<{ id: string }>(
      `insert into public.leads (org_id, name, email, phone, source, message)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [org.id, input.name ?? null, input.email, input.phone ?? null, input.source, input.message],
    );
    const id = rows[0]!.id;
    await recordEvent(
      tx,
      org.id,
      "lead_received",
      { source: input.source, ip: meta.ip ?? null, user_agent: meta.userAgent?.slice(0, 200) ?? null },
      id,
    );
    return id;
  });

  if (!billingAllowsAi(org)) {
    await recordEvent(db, org.id, "ai_skipped", { reason: "unpaid" }, leadId);
    return { status: "accepted", leadId, queued: false, reason: "unpaid" };
  }
  // The monthly lead limit is checked by the worker after classification,
  // so spam and junk submissions can't use up the quota.

  await queue.send("process_lead", { leadId, orgId: org.id }, { singletonKey: `process_lead:${leadId}` });
  return { status: "accepted", leadId, queued: true };
}
