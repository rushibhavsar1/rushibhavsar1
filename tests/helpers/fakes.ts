import type { JobName, JobPayloads, Queue, SendJobOptions } from "@/lib/queue";

export interface SentJob {
  name: JobName;
  data: unknown;
  options?: SendJobOptions;
}

/** In-memory queue that records jobs instead of writing them to pg-boss. */
export class FakeQueue implements Queue {
  jobs: SentJob[] = [];
  cancelled: string[] = [];
  private seq = 0;
  private keys = new Set<string>();

  async send<N extends JobName>(name: N, data: JobPayloads[N], options?: SendJobOptions): Promise<string | null> {
    if (options?.singletonKey) {
      if (this.keys.has(options.singletonKey)) return null;
      this.keys.add(options.singletonKey);
    }
    this.jobs.push({ name, data, options });
    return `job-${++this.seq}`;
  }

  async cancel(_name: JobName, jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }

  ofType<N extends JobName>(name: N): Array<{ data: JobPayloads[N]; options?: SendJobOptions }> {
    return this.jobs.filter((j) => j.name === name) as Array<{ data: JobPayloads[N]; options?: SendJobOptions }>;
  }

  clear(): void {
    this.jobs = [];
  }
}
