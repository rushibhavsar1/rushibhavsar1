import type { Metadata } from "next";
import Link from "next/link";
import { STATUS_LABEL, formatDateTime } from "@/components/format";
import { LeadStatusBadge } from "@/components/lead-status";
import { requireOrgContext, withUserDb } from "@/server/auth/context";
import { listLeads } from "@/server/inbox";
import type { LeadStatus } from "@/server/types";

export const metadata: Metadata = { title: "Leads" };

const STATUSES = Object.keys(STATUS_LABEL) as LeadStatus[];
const PAGE = 50;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const ctx = await requireOrgContext();
  const params = await searchParams;
  const status = STATUSES.includes(params.status as LeadStatus) ? (params.status as LeadStatus) : undefined;
  const page = Math.max(1, Number(params.page) || 1);
  const leads = await withUserDb(ctx, (tx) =>
    listLeads(tx, ctx.org.id, { status, limit: PAGE + 1, offset: (page - 1) * PAGE }),
  );
  const hasMore = leads.length > PAGE;
  const qs = (p: number) => `/leads?${new URLSearchParams({ ...(status ? { status } : {}), page: String(p) })}`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Leads</h1>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter by status">
        <Link href="/leads" className={`rounded-full px-3 py-1 ${!status ? "bg-slate-900 text-white" : "bg-white"}`}>
          All
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/leads?status=${s}`}
            className={`rounded-full px-3 py-1 ${status === s ? "bg-slate-900 text-white" : "bg-white"}`}
          >
            {STATUS_LABEL[s]}
          </Link>
        ))}
      </nav>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-3">Lead</th>
              <th className="px-4 py-3">Message</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Received</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {leads.slice(0, PAGE).map((lead) => (
              <tr key={lead.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                    {lead.name ?? lead.email}
                  </Link>
                  {lead.name ? <div className="text-xs text-slate-500">{lead.email}</div> : null}
                </td>
                <td className="max-w-md truncate px-4 py-3 text-slate-600">{lead.message}</td>
                <td className="px-4 py-3">
                  <LeadStatusBadge status={lead.status} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-500">
                  {formatDateTime(lead.created_at, ctx.org.timezone)}
                </td>
              </tr>
            ))}
            {leads.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                  No leads yet. Add the contact form to your website from{" "}
                  <Link href="/settings/integrations" className="text-brand-600 hover:underline">
                    Settings
                  </Link>
                  .
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between text-sm">
        {page > 1 ? <Link href={qs(page - 1)}>← Newer</Link> : <span />}
        {hasMore ? <Link href={qs(page + 1)}>Older →</Link> : null}
      </div>
    </div>
  );
}
