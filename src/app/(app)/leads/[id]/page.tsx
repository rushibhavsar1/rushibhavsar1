import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/components/format";
import { LeadStatusBadge } from "@/components/lead-status";
import { requireOrgContext, withUserDb } from "@/server/auth/context";
import { leadDetail } from "@/server/inbox";
import { leadAction } from "../../inbox/actions";

export const metadata: Metadata = { title: "Lead" };

const DRAFT_STATUS: Record<string, string> = {
  pending_approval: "Waiting for approval",
  approved: "Approved — sending",
  rejected: "Rejected",
  sent: "Sent",
  cancelled: "Cancelled",
};

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const detail = await withUserDb(ctx, (tx) => leadDetail(tx, ctx.org.id, id));
  if (!detail) notFound();
  const { lead, drafts, events } = detail;
  const tz = ctx.org.timezone;
  const followupsActive = lead.status === "replied" && !lead.followups_stopped_at;

  return (
    <div className="space-y-6">
      <Link href="/leads" className="text-sm text-slate-600 hover:underline">
        ← All leads
      </Link>
      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{lead.name ?? lead.email}</h1>
            <p className="text-sm text-slate-600">
              <a href={`mailto:${lead.email}`} className="hover:underline">
                {lead.email}
              </a>
              {lead.phone ? ` · ${lead.phone}` : ""} · via {lead.source} · {formatDateTime(lead.created_at, tz)}
            </p>
          </div>
          <LeadStatusBadge status={lead.status} />
        </div>
        <blockquote className="mt-4 rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap">{lead.message}</blockquote>
        {lead.classification ? (
          <p className="mt-2 text-xs text-slate-500">
            AI classification: {lead.classification}
            {lead.classification_reason ? ` — ${lead.classification_reason}` : ""}
          </p>
        ) : null}
        <form action={leadAction} className="mt-4 flex flex-wrap gap-2">
          <input type="hidden" name="leadId" value={lead.id} />
          {followupsActive ? (
            <button name="intent" value="responded" className="btn-secondary">
              They replied — stop follow-ups
            </button>
          ) : null}
          {lead.status === "new" ? (
            <button name="intent" value="redraft" className="btn-secondary">
              Write a new draft
            </button>
          ) : null}
          {lead.status !== "lost" && lead.status !== "booked" ? (
            <button name="intent" value="lost" className="btn-danger">
              Mark as lost
            </button>
          ) : null}
        </form>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Emails</h2>
        {drafts.length === 0 ? <p className="text-sm text-slate-500">No drafts yet.</p> : null}
        {drafts.map((d) => (
          <article key={d.id} className="card">
            <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              {d.kind.replace("_", " ")} · {DRAFT_STATUS[d.status]}
              {d.sent_at ? ` · ${formatDateTime(d.sent_at, tz)}` : ""}
            </p>
            <p className="mt-1 font-medium">{d.subject}</p>
            <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-slate-700">{d.body}</pre>
            {d.send_error ? <p className="mt-2 text-sm text-red-700">Send error: {d.send_error}</p> : null}
            {d.status === "pending_approval" ? (
              <Link href="/inbox" className="mt-3 inline-block text-sm text-brand-600 hover:underline">
                Review in inbox →
              </Link>
            ) : null}
          </article>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Timeline</h2>
        <ol className="card space-y-2 text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="w-40 shrink-0 text-slate-500">{formatDateTime(e.created_at, tz)}</span>
              <span>{e.type.replaceAll("_", " ")}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
