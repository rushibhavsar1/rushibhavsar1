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

import type { InlineButton, Telegram } from "@/lib/telegram";

export interface TelegramCall {
  method: "send" | "edit" | "answer";
  chatId?: string;
  messageId?: string;
  text?: string;
  buttons?: InlineButton[][];
  forceReply?: boolean;
}

/** Records Bot API calls instead of hitting Telegram. */
export class FakeTelegram implements Telegram {
  calls: TelegramCall[] = [];
  private seq = 100;

  async sendMessage(chatId: string, html: string, opts: { buttons?: InlineButton[][]; forceReply?: boolean } = {}) {
    this.calls.push({ method: "send", chatId, text: html, buttons: opts.buttons, forceReply: opts.forceReply });
    return { messageId: String(++this.seq) };
  }
  async editMessage(chatId: string, messageId: string, html: string, opts: { buttons?: InlineButton[][] } = {}) {
    this.calls.push({ method: "edit", chatId, messageId, text: html, buttons: opts.buttons });
  }
  async answerCallback(_id: string, text?: string) {
    this.calls.push({ method: "answer", text });
  }
  sent(): TelegramCall[] {
    return this.calls.filter((c) => c.method === "send");
  }
  clear(): void {
    this.calls = [];
  }
}

import { EmailError, type DomainInfo, type Mailer, type OutgoingEmail } from "@/lib/email";

/** Records outgoing emails and simulates Resend domains. */
export class FakeMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  failWith: EmailError | null = null;
  domainStatus: DomainInfo["status"] = "pending";
  verifyCalls = 0;

  async send(email: OutgoingEmail) {
    if (this.failWith) throw this.failWith;
    this.sent.push(email);
    return { id: `re_${this.sent.length}` };
  }
  async createDomain(name: string): Promise<DomainInfo> {
    return { id: `dom_${name}`, name, status: "not_started", records: [this.record()] };
  }
  async getDomain(id: string): Promise<DomainInfo> {
    return { id, name: id.replace(/^dom_/, ""), status: this.domainStatus, records: [this.record()] };
  }
  async verifyDomain() {
    this.verifyCalls += 1;
  }
  private record() {
    return { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=MIGf...", status: "pending" };
  }
}

export { EmailError };
