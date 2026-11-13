import type Stripe from "stripe";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { isPaidStatus, type PlanDef } from "@/lib/plans";
import type { Queue } from "@/lib/queue";
import { planForPriceId, priceIdForPlan, type StripeLike } from "@/lib/stripe";
import { appUrl } from "@/lib/urls";
import { recordEvent } from "@/server/events";
import { getOrganization } from "@/server/orgs";
import type { Organization, PlanId, SubscriptionStatus } from "@/server/types";

const KNOWN_STATUSES: SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
];

async function ensureCustomer(db: Db, stripe: StripeLike, org: Organization, email: string | null): Promise<string> {
  if (org.stripe_customer_id) return org.stripe_customer_id;
  const customer = await stripe.customers.create({
    name: org.name,
    email: email ?? undefined,
    metadata: { org_id: org.id },
  });
  await db.query(
    "update public.organizations set stripe_customer_id = $2 where id = $1 and stripe_customer_id is null",
    [org.id, customer.id],
  );
  return (await getOrganization(db, org.id))?.stripe_customer_id ?? customer.id;
}

/** Stripe Checkout for a new subscription. Orgs that already pay change plans in the portal. */
export async function createCheckoutSession(
  deps: { db: Db; stripe: StripeLike },
  org: Organization,
  plan: PlanDef["id"],
  ownerEmail: string | null,
): Promise<string> {
  if (org.stripe_subscription_id && !["canceled", "incomplete_expired", "none"].includes(org.subscription_status)) {
    return createPortalSession(deps.stripe, org);
  }
  const customer = await ensureCustomer(deps.db, deps.stripe, org, ownerEmail);
  const trialDays = env().STRIPE_TRIAL_DAYS;
  const hadSubscription = Boolean(org.stripe_subscription_id);
  const session = await deps.stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: org.id,
    line_items: [{ price: priceIdForPlan(plan), quantity: 1 }],
    subscription_data: {
      metadata: { org_id: org.id },
      // One free trial per business.
      ...(trialDays > 0 && !hadSubscription ? { trial_period_days: trialDays } : {}),
    },
    metadata: { org_id: org.id, plan },
    allow_promotion_codes: true,
    success_url: appUrl("/settings/billing?checkout=success"),
    cancel_url: appUrl("/settings/billing?checkout=cancelled"),
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

/** Stripe customer portal: change plan, update card, cancel, download invoices. */
export async function createPortalSession(stripe: StripeLike, org: Organization): Promise<string> {
  if (!org.stripe_customer_id) throw new Error("No Stripe customer yet");
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: appUrl("/settings/billing"),
  });
  return session.url;
}

async function findOrgForSubscription(db: Db, sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.org_id;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { rows } = await db.query<{ id: string }>(
    `select id from public.organizations
      where ($1::uuid is not null and id = $1::uuid) or stripe_subscription_id = $2 or stripe_customer_id = $3
      order by (id = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)) desc
      limit 1`,
    [fromMeta && /^[0-9a-f-]{36}$/.test(fromMeta) ? fromMeta : null, sub.id, customerId],
  );
  return rows[0]?.id ?? null;
}

/** Leads that arrived while AI was blocked get processed once the org pays again. */
export async function requeueUnprocessedLeads(db: Db, queue: Queue, orgId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `select l.id from public.leads l
      where l.org_id = $1 and l.status = 'new' and coalesce(l.classification, 'lead') = 'lead'
        and l.created_at > now() - interval '7 days'
        and not exists (select 1 from public.drafts d where d.lead_id = l.id and d.status in ('pending_approval', 'approved', 'sent'))
      order by l.created_at limit 200`,
    [orgId],
  );
  for (const r of rows) {
    await queue.send("process_lead", { leadId: r.id, orgId }, { singletonKey: `process_lead:${r.id}:requeue` });
  }
  return rows.length;
}

/** Copies a subscription's state (plan, status, period end) onto the org. */
export async function syncSubscription(
  deps: { db: Db; queue: Queue },
  sub: Stripe.Subscription,
): Promise<{ orgId: string; plan: PlanId; status: SubscriptionStatus } | null> {
  const orgId = await findOrgForSubscription(deps.db, sub);
  if (!orgId) {
    logger.warn("stripe subscription for unknown org", { subscription: sub.id });
    return null;
  }
  const before = await getOrganization(deps.db, orgId);
  if (!before) return null;

  const status: SubscriptionStatus = KNOWN_STATUSES.includes(sub.status as SubscriptionStatus)
    ? (sub.status as SubscriptionStatus)
    : "incomplete";
  const item = sub.items.data[0];
  const pricedPlan = planForPriceId(item?.price.id);
  const ended = status === "canceled" || status === "incomplete_expired";
  const plan: PlanId = ended ? "none" : (pricedPlan ?? (before.plan === "none" ? "none" : before.plan));
  const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  await deps.db.query(
    `update public.organizations
        set plan = $2, subscription_status = $3, stripe_subscription_id = $4, current_period_end = $5,
            stripe_customer_id = coalesce(stripe_customer_id, $6)
      where id = $1`,
    [orgId, plan, status, sub.id, periodEnd, customerId],
  );
  if (before.plan !== plan || before.subscription_status !== status) {
    await recordEvent(deps.db, orgId, "subscription_changed", {
      from: { plan: before.plan, status: before.subscription_status },
      to: { plan, status },
    });
  }
  const wasPaid = before.plan !== "none" && isPaidStatus(before.subscription_status);
  if (!wasPaid && plan !== "none" && isPaidStatus(status)) {
    await requeueUnprocessedLeads(deps.db, deps.queue, orgId);
  }
  return { orgId, plan, status };
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

/**
 * Handles a verified Stripe event. Always re-reads the subscription from
 * Stripe, so out-of-order deliveries still end in the latest state.
 */
export async function handleStripeEvent(
  deps: { db: Db; queue: Queue; stripe: StripeLike },
  event: Stripe.Event,
): Promise<string> {
  const retrieve = (id: string) => deps.stripe.subscriptions.retrieve(id);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (!subId) return "no_subscription";
      const orgId = session.client_reference_id ?? session.metadata?.org_id;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      if (orgId && /^[0-9a-f-]{36}$/.test(orgId)) {
        await deps.db.query(
          `update public.organizations set stripe_customer_id = coalesce(stripe_customer_id, $2), stripe_subscription_id = $3
            where id = $1`,
          [orgId, customerId ?? null, subId],
        );
      }
      await syncSubscription(deps, await retrieve(subId));
      return "synced";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const sub = event.data.object;
      // A deleted subscription can still be retrieved (status "canceled").
      await syncSubscription(deps, await retrieve(sub.id));
      return "synced";
    }
    case "invoice.paid":
    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const subId = invoiceSubscriptionId(invoice);
      if (!subId) return "no_subscription";
      const result = await syncSubscription(deps, await retrieve(subId));
      if (result) {
        await recordEvent(deps.db, result.orgId, event.type === "invoice.payment_failed" ? "payment_failed" : "invoice_paid", {
          invoice: invoice.id,
          amount: event.type === "invoice.payment_failed" ? invoice.amount_due : invoice.amount_paid,
          currency: invoice.currency,
        });
      }
      return "synced";
    }
    default:
      return "ignored";
  }
}
