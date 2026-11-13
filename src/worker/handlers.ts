import type { JobName, JobPayloads } from "@/lib/queue";
import type { WorkerDeps } from "@/server/deps";
import { followupDue } from "@/server/jobs/followup";
import { notifyOwner, notifySupportQuestion } from "@/server/jobs/notify";
import { processLead } from "@/server/jobs/process-lead";
import { sendDraft } from "@/server/jobs/send-draft";
import { maintenance, weeklyReportFanout, weeklyReportOrg } from "@/server/jobs/weekly-report";

type Handler<N extends JobName> = (deps: WorkerDeps, data: JobPayloads[N]) => Promise<unknown>;

/** Job name -> handler. The worker subscribes to every entry. */
export const handlers: { [N in JobName]?: Handler<N> } = {
  process_lead: (deps, data) => processLead(deps, data),
  notify_owner: (deps, data) => notifyOwner(deps, data),
  notify_support_question: (deps, data) => notifySupportQuestion(deps, data),
  send_draft: (deps, data) => sendDraft(deps, data),
  followup_due: (deps, data) => followupDue(deps, data),
  weekly_report: (deps) => weeklyReportFanout(deps),
  weekly_report_org: (deps, data) => weeklyReportOrg(deps, data),
  maintenance: (deps) => maintenance(deps),
};
