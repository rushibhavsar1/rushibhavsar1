import { PgBoss } from "pg-boss";
import { requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { DraftKind } from "@/server/types";

/** Background job names and their payloads (pg-boss queues). */
export interface JobPayloads {
  process_lead: { leadId: string; orgId: string };
  notify_owner: { draftId: string; orgId: string };
  send_draft: { draftId: string; orgId: string };
  followup_due: { leadId: string; orgId: string; kind: Exclude<DraftKind, "first_reply"> };
  notify_support_question: { leadId: string; orgId: string };
  weekly_report: Record<string, never>;
  weekly_report_org: { orgId: string; weekStart: string };
  maintenance: Record<string, never>;
}
export type JobName = keyof JobPayloads;

export const JOB_NAMES: JobName[] = [
  "process_lead",
  "notify_owner",
  "send_draft",
  "followup_due",
  "notify_support_question",
  "weekly_report",
  "weekly_report_org",
  "maintenance",
];

export interface SendJobOptions {
  /** Run no earlier than this time. */
  startAfter?: Date;
  /** Deduplicate: only one queued job per key. */
  singletonKey?: string;
}

export interface Queue {
  send<N extends JobName>(name: N, data: JobPayloads[N], options?: SendJobOptions): Promise<string | null>;
  cancel(name: JobName, jobId: string): Promise<void>;
}

const globalForQueue = globalThis as unknown as { __deskpilotBoss?: Promise<PgBoss> };

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of JOB_NAMES) {
    const existing = await boss.getQueue(name);
    if (!existing) {
      await boss.createQueue(name, {
        retryLimit: name === "send_draft" ? 5 : 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 300,
      });
    }
  }
}

/**
 * pg-boss instance for *sending* jobs from the web app. It does not run
 * maintenance or cron — the worker process does that.
 */
export function getBoss(): Promise<PgBoss> {
  if (!globalForQueue.__deskpilotBoss) {
    globalForQueue.__deskpilotBoss = (async () => {
      const boss = new PgBoss({
        connectionString: requireEnv("DATABASE_URL"),
        max: 3,
        supervise: false,
        schedule: false,
        application_name: "deskpilot-web",
      });
      boss.on("error", (err) => logger.error("pg-boss error (web)", { err }));
      await boss.start();
      await ensureQueues(boss);
      return boss;
    })().catch((err) => {
      globalForQueue.__deskpilotBoss = undefined;
      throw err;
    });
  }
  return globalForQueue.__deskpilotBoss;
}

export function createBossQueue(getInstance: () => Promise<PgBoss>): Queue {
  return {
    async send(name, data, options) {
      const boss = await getInstance();
      return boss.send(name, data, {
        startAfter: options?.startAfter,
        singletonKey: options?.singletonKey,
      });
    },
    async cancel(name, jobId) {
      const boss = await getInstance();
      await boss.cancel(name, jobId);
    },
  };
}

export function getQueue(): Queue {
  return createBossQueue(getBoss);
}
