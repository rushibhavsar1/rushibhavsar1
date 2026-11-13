import { AiBlockedError, AiRefusalError, type Ai } from "@/lib/ai";
import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { JobPayloads, Queue } from "@/lib/queue";
import { insertDraft } from "@/server/drafts";
import { recordEvent } from "@/server/events";
import { getKnowledgeFiles } from "@/server/knowledge";
import { getLead } from "@/server/leads/lifecycle";
import { getOrganization } from "@/server/orgs";
import type { LeadClassification } from "@/server/types";

export interface PipelineDeps {
  db: Db;
  ai: Ai;
  queue: Queue;
}

export type ProcessLeadOutcome =
  | "missing"
  | "already_processed"
  | "spam"
  | "support"
  | "drafted"
  | "draft_exists"
  | "blocked"
  | "refused";

/**
 * Worker job: classify the lead (Haiku) and, if it is a real lead, draft a
 * first reply (Sonnet) that waits for the owner's approval.
 * Safe to retry: classification is stored once and drafts are unique per kind.
 */
export async function processLead(deps: PipelineDeps, job: JobPayloads["process_lead"]): Promise<ProcessLeadOutcome> {
  const { db, ai, queue } = deps;
  const lead = await getLead(db, job.orgId, job.leadId);
  const org = await getOrganization(db, job.orgId);
  if (!lead || !org) return "missing";
  if (lead.status !== "new") return "already_processed";

  try {
    const knowledge = await getKnowledgeFiles(db, org.id);

    let category: LeadClassification | null = lead.classification;
    if (!category) {
      const result = await ai.classifyLead(org, knowledge, lead);
      category = result.category;
      await db.query(
        "update public.leads set classification = $3, classification_reason = $4 where id = $1 and org_id = $2",
        [lead.id, org.id, result.category, result.reason],
      );
      await recordEvent(db, org.id, "lead_classified", { category: result.category, reason: result.reason }, lead.id);
    }

    if (category === "spam") {
      await db.query("update public.leads set status = 'lost' where id = $1 and org_id = $2", [lead.id, org.id]);
      return "spam";
    }
    if (category === "support") {
      // No AI reply for existing customers: tell the owner to answer personally.
      await queue.send(
        "notify_support_question",
        { leadId: lead.id, orgId: org.id },
        { singletonKey: `support:${lead.id}` },
      );
      return "support";
    }

    const draft = await ai.draftReply(org, knowledge, { lead, kind: "first_reply" });
    const draftId = await insertDraft(db, org.id, lead.id, "first_reply", draft);
    if (!draftId) return "draft_exists";

    await db.query("update public.leads set status = 'drafted' where id = $1 and org_id = $2 and status = 'new'", [
      lead.id,
      org.id,
    ]);
    await queue.send("notify_owner", { draftId, orgId: org.id }, { singletonKey: `notify:${draftId}` });
    return "drafted";
  } catch (err) {
    if (err instanceof AiBlockedError) {
      await recordEvent(db, org.id, "ai_blocked", { reason: err.reason }, lead.id);
      logger.warn("ai blocked for lead", { orgId: org.id, leadId: lead.id, reason: err.reason });
      return "blocked";
    }
    if (err instanceof AiRefusalError) {
      await recordEvent(db, org.id, "ai_refused", { category: err.category }, lead.id);
      await queue.send(
        "notify_support_question",
        { leadId: lead.id, orgId: org.id },
        { singletonKey: `support:${lead.id}` },
      );
      return "refused";
    }
    throw err; // transient: pg-boss retries with backoff
  }
}
