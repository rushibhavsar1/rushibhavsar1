import { z } from "zod";
import type { Db } from "@/lib/db";
import { EmailError, type DomainInfo, type Mailer } from "@/lib/email";
import type { Queue } from "@/lib/queue";
import { recordEvent } from "@/server/events";
import { requeueBlockedSends } from "@/server/jobs/send-draft";
import { getOrganization } from "@/server/orgs";
import type { Organization } from "@/server/types";

export const sendingSettingsInput = z.object({
  sending_domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a domain like mail.yourbusiness.com"),
  from_local_part: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._+-]{1,64}$/, "Use letters, numbers, dots or dashes (e.g. hello)"),
  from_name: z.string().trim().max(80).optional().transform((v) => v || null),
  reply_to_email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || z.email().safeParse(v).success, "Enter a valid email address"),
});
export type SendingSettingsInput = z.input<typeof sendingSettingsInput>;

export class EmailSettingsError extends Error {}

/**
 * Saves sender details. A new domain is registered with Resend, which returns
 * the DNS records the owner must add before we can send from it.
 */
export async function saveSendingSettings(
  db: Db,
  mailer: Mailer | null,
  org: Organization,
  input: SendingSettingsInput,
): Promise<Organization> {
  const data = sendingSettingsInput.parse(input);
  const domainChanged = data.sending_domain !== org.sending_domain;
  let domainId = org.resend_domain_id;
  let status = org.sending_domain_status;

  if (domainChanged) {
    if (!mailer) throw new EmailSettingsError("Email sending is not configured on this server (RESEND_API_KEY).");
    try {
      const domain = await mailer.createDomain(data.sending_domain);
      domainId = domain.id;
      status = domain.status === "verified" ? "verified" : "pending";
    } catch (err) {
      if (err instanceof EmailError) throw new EmailSettingsError(`Resend: ${err.message}`);
      throw err;
    }
  }

  await db.query(
    `update public.organizations
        set sending_domain = $2, resend_domain_id = $3, sending_domain_status = $4,
            from_local_part = $5, from_name = $6, reply_to_email = $7
      where id = $1`,
    [org.id, data.sending_domain, domainId, status, data.from_local_part, data.from_name, data.reply_to_email],
  );
  await recordEvent(db, org.id, "sending_settings_saved", { domain: data.sending_domain, domain_changed: domainChanged });
  return (await getOrganization(db, org.id))!;
}

/** Asks Resend to re-check DNS, stores the result, and retries blocked sends once verified. */
export async function refreshDomainStatus(
  deps: { db: Db; mailer: Mailer; queue: Queue },
  org: Organization,
): Promise<DomainInfo | null> {
  if (!org.resend_domain_id) return null;
  if (org.sending_domain_status !== "verified") {
    await deps.mailer.verifyDomain(org.resend_domain_id).catch(() => undefined);
  }
  const info = await deps.mailer.getDomain(org.resend_domain_id);
  if (info.status !== org.sending_domain_status) {
    await deps.db.query("update public.organizations set sending_domain_status = $2 where id = $1", [
      org.id,
      info.status,
    ]);
    await recordEvent(deps.db, org.id, "sending_domain_status", { status: info.status });
    if (info.status === "verified") await requeueBlockedSends(deps, org.id);
  }
  return info;
}
