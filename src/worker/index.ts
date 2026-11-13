/**
 * Background worker: `npm run worker`.
 *
 * Runs pg-boss queues (AI processing, notifications, sending, follow-ups,
 * weekly reports). Scale by running more copies — pg-boss uses SKIP LOCKED,
 * so jobs are never processed twice concurrently.
 */
import { PgBoss } from "pg-boss";
import { createAi } from "@/lib/ai";
import { getDb, getPool } from "@/lib/db";
import { env, requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createBossQueue, ensureQueues, type JobName } from "@/lib/queue";
import { telegramFromEnv } from "@/lib/telegram";
import type { WorkerDeps } from "@/server/deps";
import { handlers } from "@/worker/handlers";

async function main() {
  const config = env();
  const boss = new PgBoss({
    connectionString: requireEnv("DATABASE_URL"),
    application_name: "deskpilot-worker",
    max: Math.max(4, config.WORKER_CONCURRENCY + 2),
  });
  boss.on("error", (err) => logger.error("pg-boss error", { err }));
  await boss.start({ attempts: 10 });
  await ensureQueues(boss);

  const db = getDb();
  const deps: WorkerDeps = {
    db,
    queue: createBossQueue(async () => boss),
    ai: createAi({ db }),
    telegram: telegramFromEnv(),
  };

  for (const [name, handler] of Object.entries(handlers) as Array<[JobName, (d: WorkerDeps, data: unknown) => Promise<unknown>]>) {
    await boss.work(name, { localConcurrency: config.WORKER_CONCURRENCY }, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          const result = await handler(deps, job.data);
          logger.info("job done", { job: name, id: job.id, ms: Date.now() - started, result });
        } catch (err) {
          logger.error("job failed", { job: name, id: job.id, err });
          throw err; // pg-boss retries with backoff
        }
      }
    });
  }

  logger.info("worker started", { queues: Object.keys(handlers), concurrency: config.WORKER_CONCURRENCY });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("worker stopping", { signal });
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
      await getPool().end();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("worker crashed on startup", { err });
  process.exit(1);
});
