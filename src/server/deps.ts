import type { Ai } from "@/lib/ai";
import type { Db } from "@/lib/db";
import type { Mailer } from "@/lib/email";
import type { Queue } from "@/lib/queue";
import type { Telegram } from "@/lib/telegram";

/** Everything a background job needs. Production values are wired in src/worker/index.ts. */
export interface WorkerDeps {
  db: Db;
  ai: Ai;
  queue: Queue;
  /** null when no bot is configured. */
  telegram: Telegram | null;
  /** null when Resend is not configured. */
  mailer: Mailer | null;
  now?: () => Date;
}
