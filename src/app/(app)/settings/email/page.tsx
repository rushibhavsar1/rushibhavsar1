import type { Metadata } from "next";
import { CheckDomainButton, EmailSettingsForm } from "@/components/client/email-settings-form";
import { mailerFromEnv, type DnsRecord } from "@/lib/email";
import { logger } from "@/lib/logger";
import { requireOrgContext } from "@/server/auth/context";
import { checkDomain, saveEmailSettings } from "./actions";

export const metadata: Metadata = { title: "Email sending" };

const STATUS: Record<string, { label: string; className: string }> = {
  not_started: { label: "Not set up", className: "text-slate-600" },
  pending: { label: "Waiting for DNS", className: "text-amber-700" },
  verified: { label: "Verified", className: "text-emerald-700" },
  failed: { label: "Verification failed", className: "text-red-700" },
};

export default async function EmailSettingsPage() {
  const { org } = await requireOrgContext();
  let records: DnsRecord[] = [];
  const mailer = mailerFromEnv();
  if (mailer && org.resend_domain_id) {
    try {
      records = (await mailer.getDomain(org.resend_domain_id)).records;
    } catch (err) {
      logger.warn("could not load domain records", { err, orgId: org.id });
    }
  }
  const status = STATUS[org.sending_domain_status] ?? STATUS.not_started!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Email sending</h1>
        <p className="mt-1 text-sm text-slate-600">
          Replies are sent from your own domain so they look like they came from you (and land in the inbox).
        </p>
      </div>
      <section className="card space-y-4">
        <p className="text-sm">
          Status: <strong className={status.className}>{status.label}</strong>
          {org.sending_domain ? (
            <span className="text-slate-600">
              {" "}
              · sending as {org.from_local_part}@{org.sending_domain}
            </span>
          ) : null}
        </p>
        <EmailSettingsForm
          action={saveEmailSettings}
          values={{
            sending_domain: org.sending_domain ?? "",
            from_local_part: org.from_local_part,
            from_name: org.from_name ?? "",
            reply_to_email: org.reply_to_email ?? "",
          }}
        />
      </section>
      {org.resend_domain_id ? (
        <section className="card space-y-4">
          <h2 className="text-lg font-semibold">DNS records</h2>
          <p className="text-sm text-slate-600">
            Add these at your domain provider (GoDaddy, Namecheap, Cloudflare…), then check verification.
          </p>
          {records.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500 uppercase">
                  <tr>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Value</th>
                    <th className="py-2 pr-4">Priority</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {records.map((r) => (
                    <tr key={`${r.type}-${r.name}-${r.value}`}>
                      <td className="py-2 pr-4">{r.type}</td>
                      <td className="py-2 pr-4 break-all">{r.name}</td>
                      <td className="max-w-md py-2 pr-4 break-all">{r.value}</td>
                      <td className="py-2 pr-4">{r.priority ?? ""}</td>
                      <td className="py-2">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Records could not be loaded right now.</p>
          )}
          <CheckDomainButton action={checkDomain} />
        </section>
      ) : null}
    </div>
  );
}
