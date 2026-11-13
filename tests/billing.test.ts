import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAi } from "@/lib/ai";
import { resetEnvCache } from "@/lib/env";
import { billingAllowsAi, planLimits } from "@/lib/plans";
import type { StripeLike } from "@/lib/stripe";
import { createCheckoutSession } from "@/server/billing/service";
import { getOrganization } from "@/server/orgs";
import { getLead } from "@/server/leads/lifecycle";
import type { Organization } from "@/server/types";
import { handleStripeWebhook } from "@/server/webhooks/stripe";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { fakeAnthropic, scriptedModel } from "./helpers/fake-anthropic";
import { FakeQueue } from "./helpers/fakes";
import { createOrgFixture, insertLead } from "./helpers/fixtures";

const WEBHOOK_SECRET = "whsec_test_secret";
const real = new Stripe("sk_test_dummy");

class FakeStripe implements StripeLike {
  subs = new Map<string, Stripe.Subscription>();
  checkoutCalls: Stripe.Checkout.SessionCreateParams[] = [];
  customersCreated = 0;
  customers = {
    create: (async () => ({ id: `cus_${++this.customersCreated}` })) as unknown as StripeLike["customers"]["create"],
  };
  checkout = {
    sessions: {
      create: (async (params: Stripe.Checkout.SessionCreateParams) => {
        this.checkoutCalls.push(params);
        return { url: "https://checkout.stripe.test/c/1" };
      }) as unknown as StripeLike["checkout"]["sessions"]["create"],
    },
  };
  billingPortal = {
    sessions: {
      create: (async () => ({ url: "https://billing.stripe.test/p/1" })) as unknown as StripeLike["billingPortal"]["sessions"]["create"],
    },
  };
  subscriptions = {
    retrieve: (async (id: string) => {
      const sub = this.subs.get(id);
      if (!sub) throw new Error(`no such subscription ${id}`);
      return sub;
    }) as unknown as StripeLike["subscriptions"]["retrieve"],
  };
  webhooks = real.webhooks;
}

function subscription(id: string, orgId: string, status: string, price = "price_growth"): Stripe.Subscription {
  return {
    id,
    object: "subscription",
    customer: "cus_1",
    status,
    metadata: { org_id: orgId },
    items: { object: "list", data: [{ price: { id: price }, current_period_end: 1_800_000_000 }] },
  } as unknown as Stripe.Subscription;
}

function webhookRequest(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ object: "event", api_version: "2026-10-28.endive", created: 1, ...event });
  const header = real.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

let eventSeq = 0;
const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_${++eventSeq}`, type, data: { object } });

describe("Stripe billing", () => {
  let t: TestDatabase;
  let org: Organization;
  const queue = new FakeQueue();
  const stripe = new FakeStripe();
  const deps = () => ({ db: t.db, queue, stripe, secret: WEBHOOK_SECRET });
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.STRIPE_PRICE_STARTER = "price_starter";
    process.env.STRIPE_PRICE_GROWTH = "price_growth";
    process.env.STRIPE_PRICE_PRO = "price_pro";
    process.env.STRIPE_TRIAL_DAYS = "14";
    resetEnvCache();
    t = await createTestDb();
    org = (await createOrgFixture(t.db, { plan: "none", status: "none" })).org;
  });
  afterAll(async () => {
    process.env = saved;
    resetEnvCache();
    await t.close();
  });
  beforeEach(() => queue.clear());

  const reload = async () => (org = (await getOrganization(t.db, org.id))!);

  it("plans set the monthly lead limit and AI cost cap", () => {
    expect(planLimits("starter")).toEqual({ monthlyLeadLimit: 100, monthlyAiCapUsd: 10 });
    expect(planLimits("growth").monthlyLeadLimit).toBeGreaterThan(planLimits("starter").monthlyLeadLimit);
    expect(planLimits("pro").monthlyAiCapUsd).toBeGreaterThan(planLimits("growth").monthlyAiCapUsd);
    expect(planLimits("none")).toEqual({ monthlyLeadLimit: 0, monthlyAiCapUsd: 0 });
  });

  it("starts Stripe Checkout with the plan's price, a customer and a trial", async () => {
    const url = await createCheckoutSession({ db: t.db, stripe }, org, "growth", "owner@biz.com");
    expect(url).toBe("https://checkout.stripe.test/c/1");
    const params = stripe.checkoutCalls[0]!;
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: org.id,
      line_items: [{ price: "price_growth", quantity: 1 }],
    });
    expect(params.subscription_data?.trial_period_days).toBe(14);
    await createCheckoutSession({ db: t.db, stripe }, await reload(), "starter", "owner@biz.com");
    expect(stripe.customersCreated).toBe(1); // customer reused
  });

  it("rejects webhooks with a bad signature", async () => {
    const res = await handleStripeWebhook(webhookRequest(evt("invoice.paid", {}), "whsec_wrong"), deps());
    expect(res.status).toBe(400);
  });

  it("checkout completed -> plan active, AI unblocked, waiting leads processed", async () => {
    const waiting = await insertLead(t.db, org.id);
    stripe.subs.set("sub_1", subscription("sub_1", org.id, "trialing"));
    const res = await handleStripeWebhook(
      webhookRequest(
        evt("checkout.session.completed", {
          object: "checkout.session",
          id: "cs_1",
          client_reference_id: org.id,
          customer: "cus_1",
          subscription: "sub_1",
          metadata: { org_id: org.id },
        }),
      ),
      deps(),
    );
    expect(res.status).toBe(200);
    await reload();
    expect(org).toMatchObject({ plan: "growth", subscription_status: "trialing", stripe_subscription_id: "sub_1" });
    expect(org.current_period_end?.getTime()).toBe(1_800_000_000_000);
    expect(billingAllowsAi(org)).toBe(true);
    expect(queue.ofType("process_lead").map((j) => j.data.leadId)).toContain(waiting);
  });

  it("payment failed -> AI processing is blocked", async () => {
    stripe.subs.set("sub_1", subscription("sub_1", org.id, "past_due"));
    await handleStripeWebhook(
      webhookRequest(
        evt("invoice.payment_failed", {
          object: "invoice",
          id: "in_1",
          amount_due: 12900,
          currency: "usd",
          parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
        }),
      ),
      deps(),
    );
    await reload();
    expect(org.subscription_status).toBe("past_due");
    expect(billingAllowsAi(org)).toBe(false);

    const api = fakeAnthropic(scriptedModel());
    const lead = (await getLead(t.db, org.id, await insertLead(t.db, org.id)))!;
    await expect(createAi({ db: t.db, client: api.client }).classifyLead(org, {}, lead)).rejects.toMatchObject({
      reason: "unpaid",
    });
    expect(api.requests).toHaveLength(0);
  });

  it("invoice paid -> active again", async () => {
    stripe.subs.set("sub_1", subscription("sub_1", org.id, "active", "price_pro"));
    await handleStripeWebhook(
      webhookRequest(
        evt("invoice.paid", {
          object: "invoice",
          id: "in_2",
          amount_paid: 29900,
          currency: "usd",
          parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
        }),
      ),
      deps(),
    );
    await reload();
    expect(org).toMatchObject({ plan: "pro", subscription_status: "active" });
  });

  it("subscription cancelled -> no plan, AI blocked", async () => {
    stripe.subs.set("sub_1", subscription("sub_1", org.id, "canceled", "price_pro"));
    await handleStripeWebhook(
      webhookRequest(evt("customer.subscription.deleted", { object: "subscription", id: "sub_1", customer: "cus_1" })),
      deps(),
    );
    await reload();
    expect(org).toMatchObject({ plan: "none", subscription_status: "canceled" });
    expect(billingAllowsAi(org)).toBe(false);
  });

  it("processes each event once", async () => {
    const event = evt("customer.subscription.updated", { object: "subscription", id: "sub_1", customer: "cus_1" });
    const first = await handleStripeWebhook(webhookRequest(event), deps());
    const second = await handleStripeWebhook(webhookRequest(event), deps());
    expect(await first.json()).toMatchObject({ result: "synced" });
    expect(await second.json()).toMatchObject({ duplicate: true });
  });
});
