import { EmailError } from "@/lib/email";
import { logger } from "@/lib/logger";
import type { JobPayloads } from "@/lib/queue";
import type { WorkerDeps } from "@/server/deps";
import { getDraft } from "@/server/drafts";
import { fromAddress, messageIdFor, textToHtml } from "@/server/email/render";
import { recordEvent } from "@/server/events";
import { getLead } from "@/server/leads/lifecycle";
import { getOrganization, getOwnerEmails } from "@/server/orgs";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Follow-ups are drafted (for approval) this many days after the first reply is sent. */
export const FOLLOWUP_SCHEDULE = [
  { kind: "followup_1" as const, days: 2 },
  { kind: "followup_2" as const, days: 5 },
];

export type SendOutcome =
  | "missing"
  | "not_approved"
  | "already_sent"
  | "cancelled"
  | "no_mailer"
  | "domain_not_verified"
  | "failed"
  | "sent";

async function markSendProblem(deps: Pick<WorkerDeps, "db">, orgId: string, draftId: string, leadId: string, error: string, type: string) {
  await deps.db.query("update public.drafts set send_error = $3 where id = $1 and org_id = $2", [draftId, orgId, error]);
  await recordEvent(deps.db, orgId, type, { draft_id: draftId, error }, leadId);
}

/**
 * Sends an APPROVED draft from the org's verified domain via Resend.
 * Unapproved drafts are never sent. Safe to retry (idempotency key per draft).
 */
export async function sendDraft(
  deps: Pick<WorkerDeps, "db" | "mailer" | "queue" | "telegram" | "now">,
  job: JobPayloads["send_draft"],
): Promise<SendOutcome> {
  const { db } = deps;
  const draft = await getDraft(db, job.orgId, job.draftId);
  if (!draft) return "missing";
  if (draft.status === "sent") return "already_sent";
  if (draft.status !== "approved") return "not_approved";

  const [lead, org] = await Promise.all([getLead(db, job.orgId, draft.lead_id), getOrganization(db, job.orgId)]);
  if (!lead || !org) return "missing";

  // A follow-up approved earlier must not go out if the lead has since replied, booked or been closed.
  // (A first reply inviting them to book is pointless once they have booked.)
  const stale =
    lead.status === "lost" ||
    lead.status === "booked" ||
    (draft.kind !== "first_reply" && (lead.followups_stopped_at !== null || lead.lead_responded_at !== null));
  if (stale) {
    await db.query("update public.drafts set status = 'cancelled' where id = $1 and org_id = $2 and status = 'approved'", [
      draft.id,
      org.id,
    ]);
    await recordEvent(db, org.id, "send_cancelled", { draft_id: draft.id, reason: "lead_closed" }, lead.id);
    return "cancelled";
  }

  if (!deps.mailer) {
    await markSendProblem(deps, org.id, draft.id, lead.id, "Email sending is not configured on the server.", "send_blocked");
    return "no_mailer";
  }
  if (!org.sending_domain || org.sending_domain_status !== "verified") {
    await markSendProblem(
      deps,
      org.id,
      draft.id,
      lead.id,
      "Your sending domain is not verified yet (Settings → Email sending).",
      "send_blocked",
    );
    return "domain_not_verified";
  }

  const replyTo = org.reply_to_email ?? (await getOwnerEmails(db, org.id))[0];
  const headers: Record<string, string> = { "Message-ID": messageIdFor(draft.id, org.sending_domain) };
  if (draft.kind !== "first_reply") {
    const first = await db.query<{ id: string }>(
      "select id from public.drafts where lead_id = $1 and org_id = $2 and kind = 'first_reply' and status = 'sent' limit 1",
      [lead.id, org.id],
    );
    if (first.rows[0]) {
      const ref = messageIdFor(first.rows[0].id, org.sending_domain);
      headers["In-Reply-To"] = ref;
      headers["References"] = ref;
    }
  }

  let resendId: string;
  try {
    const result = await deps.mailer.send({
      from: fromAddress(org),
      to: lead.email,
      replyTo,
      subject: draft.subject,
      text: draft.body,
      html: textToHtml(draft.body),
      headers,
      idempotencyKey: `draft-${draft.id}`,
    });
    resendId = result.id;
  } catch (err) {
    if (err instanceof EmailError && !err.retryable) {
      await markSendProblem(deps, org.id, draft.id, lead.id, err.message, "send_failed");
      return "failed";
    }
    throw err; // transient: pg-boss retries
  }

  const sentAt = deps.now?.() ?? new Date();
  await db.transaction(async (tx) => {
    await tx.query(
      `update public.drafts set status = 'sent', sent_at = $3, resend_email_id = $4, send_error = null
        where id = $1 and org_id = $2 and status = 'approved'`,
      [draft.id, org.id, sentAt.toISOString(), resendId],
    );
    if (draft.kind === "first_reply") {
      await tx.query(
        `update public.leads set status = 'replied', first_replied_at = coalesce(first_replied_at, $3)
          where id = $1 and org_id = $2 and status not in ('booked', 'lost')`,
        [lead.id, org.id, sentAt.toISOString()],
      );
    }
    await recordEvent(tx, org.id, "email_sent", { draft_id: draft.id, kind: draft.kind, resend_id: resendId }, lead.id);
  });

  if (draft.kind === "first_reply" && !lead.followups_stopped_at) {
    for (const step of FOLLOWUP_SCHEDULE) {
      await deps.queue.send(
        "followup_due",
        { leadId: lead.id, orgId: org.id, kind: step.kind },
        { startAfter: new Date(sentAt.getTime() + step.days * DAY_MS), singletonKey: `${step.kind}:${lead.id}` },
      );
    }
  }

  if (deps.telegram && org.telegram_chat_id && draft.telegram_message_id) {
    await deps.telegram
      .editMessage(org.telegram_chat_id, draft.telegram_message_id, `📤 Sent to ${lead.email}: “${draft.subject}”`)
      .catch((err) => logger.warn("telegram sent-update failed", { err }));
  }
  return "sent";
}

/** After a domain is verified, retry approved drafts that were blocked. */
export async function requeueBlockedSends(deps: Pick<WorkerDeps, "db" | "queue">, orgId: string): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    "select id from public.drafts where org_id = $1 and status = 'approved' and send_error is not null",
    [orgId],
  );
  for (const row of rows) {
    await deps.queue.send("send_draft", { draftId: row.id, orgId }, { singletonKey: `send:${row.id}:${Date.now()}` });
  }
  return rows.length;
}
