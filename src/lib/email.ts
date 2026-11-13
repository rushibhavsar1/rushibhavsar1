import { Resend } from "resend";
import { env } from "@/lib/env";

export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  /** Same key within 24h = Resend sends at most once (safe job retries). */
  idempotencyKey?: string;
}

export type DomainStatus = "not_started" | "pending" | "verified" | "failed";

export interface DnsRecord {
  record: string;
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: string;
}

export interface DomainInfo {
  id: string;
  name: string;
  status: DomainStatus;
  records: DnsRecord[];
}

/** Outgoing email + sending-domain management (Resend). */
export interface Mailer {
  send(email: OutgoingEmail): Promise<{ id: string }>;
  createDomain(name: string): Promise<DomainInfo>;
  getDomain(id: string): Promise<DomainInfo>;
  verifyDomain(id: string): Promise<void>;
}

export class EmailError extends Error {
  constructor(
    message: string,
    /** False for problems a retry cannot fix (bad address, unverified domain...). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

function mapStatus(status: string): DomainStatus {
  if (status === "verified") return "verified";
  if (status === "failed" || status === "partially_failed") return "failed";
  if (status === "not_started") return "not_started";
  return "pending";
}

function unwrap<T>(res: { data: T | null; error: { message: string; statusCode: number | null } | null }): T {
  if (res.error || !res.data) {
    const status = res.error?.statusCode ?? null;
    // 429 and 5xx (or no status: network) are worth retrying; 4xx are not.
    const retryable = status === null || status === 429 || status >= 500;
    throw new EmailError(res.error?.message ?? "Unknown email error", retryable);
  }
  return res.data;
}

export function createResendMailer(apiKey: string): Mailer {
  const resend = new Resend(apiKey);
  const toInfo = (d: { id: string; name: string; status: string; records?: unknown[] }): DomainInfo => ({
    id: d.id,
    name: d.name,
    status: mapStatus(d.status),
    records: ((d.records ?? []) as DnsRecord[]).map((r) => ({
      record: r.record,
      type: r.type,
      name: r.name,
      value: r.value,
      priority: r.priority,
      status: r.status,
    })),
  });

  return {
    async send(email) {
      const res = await resend.emails.send(
        {
          from: email.from,
          to: email.to,
          replyTo: email.replyTo,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: email.headers,
        },
        email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : undefined,
      );
      return { id: unwrap(res).id };
    },
    async createDomain(name) {
      return toInfo(unwrap(await resend.domains.create({ name })));
    },
    async getDomain(id) {
      return toInfo(unwrap(await resend.domains.get(id)));
    },
    async verifyDomain(id) {
      unwrap(await resend.domains.verify(id));
    },
  };
}

export function mailerFromEnv(): Mailer | null {
  const key = env().RESEND_API_KEY;
  return key ? createResendMailer(key) : null;
}
