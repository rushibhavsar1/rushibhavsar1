import type { Metadata } from "next";
import { formatDateTime, formatUsd } from "@/components/format";
import { billingAllowsAi, PLANS, planLimits } from "@/lib/plans";
import { requireOrgContext, withUserDb } from "@/server/auth/context";
import { monthlyUsage } from "@/server/usage";
import { openBillingPortal, startCheckout } from "./actions";

export const metadata: Metadata = { title: "Billing" };

const STATUS_TEXT: Record<string, string> = {
  none: "No subscription",
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment failed — please update your card",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Waiting for payment",
  incomplete_expired: "Payment not completed",
  paused: "Paused",
};

const ERRORS: Record<string, string> = {
  plan: "Unknown plan.",
  checkout: "Could not open checkout. Please try again.",
  portal: "Could not open the billing portal. Please try again.",
};

function Meter({ label, used, limit, format }: { label: string; used: number; limit: number; format: (n: number) => string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-medium tabular-nums">
          {format(used)} / {format(limit)}
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-slate-200" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-2 rounded-full ${pct >= 90 ? "bg-red-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string }>;
}) {
  const ctx = await requireOrgContext();
  const { org } = ctx;
  const params = await searchParams;
  const usage = await withUserDb(ctx, (tx) => monthlyUsage(tx, org.id));
  const limits = planLimits(org.plan);
  const paid = billingAllowsAi(org);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-slate-600">Plans set your monthly lead limit and AI budget.</p>
      </div>

      {params.checkout === "success" ? (
        <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
          Thanks! Your subscription is being activated — this page updates within a few seconds.
        </p>
      ) : null}
      {params.error && ERRORS[params.error] ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{ERRORS[params.error]}</p>
      ) : null}

      <section className="card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-600">Current plan</p>
            <p className="text-lg font-semibold">
              {org.plan === "none" ? "None" : PLANS[org.plan].name} ·{" "}
              <span className={paid ? "text-emerald-700" : "text-amber-700"}>
                {STATUS_TEXT[org.subscription_status]}
              </span>
            </p>
            {org.current_period_end ? (
              <p className="text-xs text-slate-500">Renews {formatDateTime(org.current_period_end, org.timezone)}</p>
            ) : null}
          </div>
          {org.stripe_customer_id ? (
            <form action={openBillingPortal}>
              <button className="btn-secondary">Manage billing</button>
            </form>
          ) : null}
        </div>
        {!paid ? (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
            AI replies are paused until you have an active plan. New leads are still saved and will be processed as soon
            as you subscribe.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Meter label="Leads this month" used={usage.leads} limit={limits.monthlyLeadLimit} format={(n) => String(n)} />
          <Meter label="AI budget this month" used={usage.aiUsd} limit={limits.monthlyAiCapUsd} format={formatUsd} />
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {Object.values(PLANS).map((plan) => {
          const current = org.plan === plan.id && paid;
          return (
            <div key={plan.id} className={`card flex flex-col ${current ? "ring-2 ring-brand-600" : ""}`}>
              <h2 className="text-lg font-semibold">{plan.name}</h2>
              <p className="mt-1 text-2xl font-bold">{plan.priceLabel}</p>
              <ul className="mt-4 flex-1 space-y-1 text-sm text-slate-600">
                <li>{plan.monthlyLeadLimit.toLocaleString()} leads / month</li>
                <li>{formatUsd(plan.monthlyAiCapUsd)} AI budget / month</li>
                <li>Web + Telegram approvals</li>
                <li>Day 2 &amp; day 5 follow-ups</li>
              </ul>
              <form action={startCheckout} className="mt-6">
                <input type="hidden" name="plan" value={plan.id} />
                <button className={current ? "btn-secondary w-full" : "btn-primary w-full"} disabled={current}>
                  {current ? "Current plan" : paid ? "Switch plan" : "Choose plan"}
                </button>
              </form>
            </div>
          );
        })}
      </section>
    </div>
  );
}
