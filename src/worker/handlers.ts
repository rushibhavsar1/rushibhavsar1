import type { JobName, JobPayloads } from "@/lib/queue";
import type { WorkerDeps } from "@/server/deps";
import { processLead } from "@/server/jobs/process-lead";

type Handler<N extends JobName> = (deps: WorkerDeps, data: JobPayloads[N]) => Promise<unknown>;

/** Job name -> handler. The worker subscribes to every entry. */
export const handlers: { [N in JobName]?: Handler<N> } = {
  process_lead: (deps, data) => processLead(deps, data),
};
