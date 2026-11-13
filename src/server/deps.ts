import type { Ai } from "@/lib/ai";
import type { Db } from "@/lib/db";
import type { Queue } from "@/lib/queue";

/** Everything a background job needs. Production values are wired in src/worker/index.ts. */
export interface WorkerDeps {
  db: Db;
  ai: Ai;
  queue: Queue;
  now?: () => Date;
}
