import { logger } from "@/lib/logger";
import type { JobPayloads } from "@/lib/queue";
import type { WorkerDeps } from "@/server/deps";
import { draftWarnings, getDraft } from "@/server/drafts";
import { recordEvent } from "@/server/events";
import { getLead } from "@/server/leads/lifecycle";
import { getOrganization } from "@/server/orgs";
import { draftButtons, draftMessage, supportButtons, supportMessage } from "@/server/telegram/messages";

/**
 * Tells the owner a draft is waiting: the web inbox always shows it, and if
 * Telegram is linked the draft arrives there with Approve / Edit / Reject.
 */
export async function notifyOwner(deps: Pick<WorkerDeps, "db" | "telegram">, job: JobPayloads["notify_owner"]) {
  const { db, telegram } = deps;
  const draft = await getDraft(db, job.orgId, job.draftId);
  if (!draft || draft.status !== "pending_approval") return "skipped";
  const [lead, org] = await Promise.all([getLead(db, job.orgId, draft.lead_id), getOrganization(db, job.orgId)]);
  if (!lead || !org) return "skipped";

  const channels: string[] = ["web"];
  if (telegram && org.telegram_chat_id) {
    const warnings = (await draftWarnings(db, org.id, [draft.id]))[draft.id] ?? [];
    const sent = await telegram.sendMessage(org.telegram_chat_id, draftMessage(lead, draft, warnings), {
      buttons: draftButtons(draft),
    });
    await db.query("update public.drafts set telegram_message_id = $3::bigint where id = $1 and org_id = $2", [
      draft.id,
      org.id,
      sent.messageId,
    ]);
    channels.push("telegram");
  }

  if (draft.kind === "first_reply") {
    await db.query(
      "update public.leads set status = 'awaiting_approval' where id = $1 and org_id = $2 and status in ('new', 'drafted')",
      [lead.id, org.id],
    );
  }
  await recordEvent(db, org.id, "owner_notified", { draft_id: draft.id, channels }, lead.id);
  return channels.join("+");
}

/** Support questions (and messages the AI declined) go to the owner to answer personally. */
export async function notifySupportQuestion(
  deps: Pick<WorkerDeps, "db" | "telegram">,
  job: JobPayloads["notify_support_question"],
) {
  const { db, telegram } = deps;
  const [lead, org] = await Promise.all([getLead(db, job.orgId, job.leadId), getOrganization(db, job.orgId)]);
  if (!lead || !org) return "skipped";
  if (!telegram || !org.telegram_chat_id) return "web_only";
  const reason = lead.classification === "support" ? "support" : "refused";
  try {
    await telegram.sendMessage(org.telegram_chat_id, supportMessage(lead, reason), {
      buttons: supportButtons(lead.id),
    });
  } catch (err) {
    logger.warn("telegram support notice failed", { err, orgId: org.id });
    throw err;
  }
  await recordEvent(db, org.id, "owner_notified", { reason, channels: ["web", "telegram"] }, lead.id);
  return "telegram";
}
