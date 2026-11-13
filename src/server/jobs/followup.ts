import { AiBlockedError, AiRefusalError } from "@/lib/ai";
import type { JobPayloads } from "@/lib/queue";
import type { WorkerDeps } from "@/server/deps";
import { insertDraft, sentEmailsForLead } from "@/server/drafts";
import { recordEvent } from "@/server/events";
import { getKnowledgeFiles } from "@/server/knowledge";
import { getLead } from "@/server/leads/lifecycle";
import { getOrganization } from "@/server/orgs";

export type FollowupOutcome = "missing" | "stopped" | "drafted" | "draft_exists" | "blocked" | "refused";

/**
 * Runs on day 2 and day 5 after the first reply. Drafts a follow-up that —
 * like every email — waits for the owner's approval. Skips if the lead has
 * replied, booked, or follow-ups were stopped.
 */
export async function followupDue(
  deps: Pick<WorkerDeps, "db" | "ai" | "queue">,
  job: JobPayloads["followup_due"],
): Promise<FollowupOutcome> {
  const { db, ai, queue } = deps;
  const [lead, org] = await Promise.all([getLead(db, job.orgId, job.leadId), getOrganization(db, job.orgId)]);
  if (!lead || !org) return "missing";
  if (
    lead.status !== "replied" ||
    lead.followups_stopped_at !== null ||
    lead.lead_responded_at !== null ||
    lead.booked_at !== null
  ) {
    return "stopped";
  }

  const sent = await sentEmailsForLead(db, org.id, lead.id);
  const first = sent.find((e) => e.kind === "first_reply");
  if (!first) return "stopped";

  if (job.kind === "followup_2") {
    // The owner never acted on follow-up #1: replace it rather than stacking two.
    await db.query(
      `update public.drafts set status = 'cancelled'
        where lead_id = $1 and org_id = $2 and kind = 'followup_1' and status = 'pending_approval'`,
      [lead.id, org.id],
    );
  }

  try {
    const knowledge = await getKnowledgeFiles(db, org.id);
    const draft = await ai.draftReply(org, knowledge, { lead, kind: job.kind, previousEmails: sent });
    // Keep the conversation in one thread in the lead's mail app.
    const subject = /^re:/i.test(first.subject) ? first.subject : `Re: ${first.subject}`;
    const draftId = await insertDraft(db, org.id, lead.id, job.kind, { ...draft, subject: subject.slice(0, 200) });
    if (!draftId) return "draft_exists";
    await queue.send("notify_owner", { draftId, orgId: org.id }, { singletonKey: `notify:${draftId}` });
    return "drafted";
  } catch (err) {
    if (err instanceof AiBlockedError) {
      await recordEvent(db, org.id, "ai_blocked", { reason: err.reason, kind: job.kind }, lead.id);
      return "blocked";
    }
    if (err instanceof AiRefusalError) {
      await recordEvent(db, org.id, "ai_refused", { category: err.category, kind: job.kind }, lead.id);
      return "refused";
    }
    throw err;
  }
}
