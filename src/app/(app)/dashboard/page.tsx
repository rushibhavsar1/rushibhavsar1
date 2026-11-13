import type { Metadata } from "next";
import Link from "next/link";
import { formatDateTime, formatDuration, formatUsd } from "@/components/format";
import { LeadStatusBadge } from "@/components/lead-status";
import { compare, StatTile } from "@/components/stat-tile";
import { billingAllowsAi } from "@/lib/plans";
import { requireOrgContext, withUserDb } from "@/server/auth/context";
import { listLeads } from "@/server/inbox";
import { dashboardStats } from "@/server/stats";

export const metadata: Metadata = { title: "Dashboard" };

const PERIOD = "this time last week";

export default async function DashboardPage() {
  const ctx = await requireOrgContext();
  const { org } = ctx;
  const [stats, recent] = await withUserDb(ctx, async (tx) =>
    Promise.all([dashboardStats(tx, org.id, org.timezone), listLeads(tx, org.id, { limit: 8 })]),
  );
  const { current, previous } = stats;
  const count = (n: number) => n.toLocaleString();

  const setup = [
    { done: Boolean(org.onboarding_completed_at), label: "Teach DeskPilot your voice and prices", href: "/onboarding" },
    { done: billingAllowsAi(org), label: "Choose a plan (AI replies are paused until then)", href: "/settings/billing" },
    { done: org.sending_domain_status === "verified", label: "Verify your sending domain", href: "/settings/email" },
    { done: Boolean(org.telegram_chat_id), label: "Connect Telegram for one-tap approvals", href: "/settings/telegram" },
    { done: recent.length > 0, label: "Add the contact form to your website", href: "/settings/integrations" },
  ];
  const todo = setup.filter((s) => !s.done);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{org.name}</h1>
          <p className="text-sm text-slate-600">This week, since {formatDateTime(stats.start, org.timezone)}</p>
        </div>
        {stats.pendingApprovals > 0 ? (
          <Link href="/inbox" className="btn-primary">
            {stats.pendingApprovals} draft{stats.pendingApprovals === 1 ? "" : "s"} waiting for approval →
          </Link>
        ) : null}
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="This week">
        <StatTile
          label="Leads this week"
          value={count(current.leads)}
          delta={compare(current.leads, previous.leads, { upIsGood: true, format: count, period: PERIOD })}
          hint={`${count(current.answered)} answered`}
        />
        <StatTile
          label="Average reply time"
          value={formatDuration(current.avgReplySeconds)}
          delta={compare(current.avgReplySeconds, previous.avgReplySeconds, {
            upIsGood: false,
            format: formatDuration,
            period: PERIOD,
            words: ["slower", "faster"],
          })}
          hint="From enquiry to your approved reply"
        />
        <StatTile
          label="Calls booked"
          value={count(current.booked)}
          delta={compare(current.booked, previous.booked, { upIsGood: true, format: count, period: PERIOD })}
        />
        <StatTile
          label="AI cost this week"
          value={formatUsd(current.aiCostUsd)}
          delta={compare(current.aiCostUsd, previous.aiCostUsd, { upIsGood: null, format: formatUsd, period: PERIOD })}
        />
      </section>

      {todo.length > 0 ? (
        <section className="card">
          <h2 className="font-semibold">Finish setting up</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {setup.map((s) => (
              <li key={s.href} className="flex items-center gap-2">
                <span aria-hidden className={s.done ? "text-emerald-600" : "text-slate-400"}>
                  {s.done ? "✓" : "○"}
                </span>
                {s.done ? (
                  <span className="text-slate-500 line-through">{s.label}</span>
                ) : (
                  <Link href={s.href} className="text-brand-600 hover:underline">
                    {s.label}
                  </Link>
                )}
                <span className="sr-only">{s.done ? "(done)" : "(to do)"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Latest leads</h2>
          <Link href="/leads" className="text-sm text-brand-600 hover:underline">
            All leads →
          </Link>
        </div>
        <div className="card divide-y divide-slate-100 p-0">
          {recent.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No leads yet.</p>
          ) : (
            recent.map((lead) => (
              <Link key={lead.id} href={`/leads/${lead.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{lead.name ?? lead.email}</p>
                  <p className="truncate text-sm text-slate-500">{lead.message}</p>
                </div>
                <LeadStatusBadge status={lead.status} />
                <span className="hidden w-36 text-right text-xs text-slate-500 sm:block">
                  {formatDateTime(lead.created_at, org.timezone)}
                </span>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
