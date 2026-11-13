import Stripe from "stripe";
import { env, requireEnv } from "@/lib/env";
import { PLANS, type PlanDef } from "@/lib/plans";

export type { Stripe };

/** The parts of the Stripe client DeskPilot uses (tests pass a fake). */
export interface StripeLike {
  customers: Pick<Stripe["customers"], "create">;
  checkout: { sessions: Pick<Stripe["checkout"]["sessions"], "create"> };
  billingPortal: { sessions: Pick<Stripe["billingPortal"]["sessions"], "create"> };
  subscriptions: Pick<Stripe["subscriptions"], "retrieve">;
  webhooks: Pick<Stripe["webhooks"], "constructEvent">;
}

let client: Stripe | undefined;

export function getStripe(): Stripe {
  client ??= new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
    appInfo: { name: "DeskPilot" },
    maxNetworkRetries: 2,
  });
  return client;
}

export function priceIdForPlan(plan: PlanDef["id"]): string {
  return requireEnv(PLANS[plan].stripePriceEnv);
}

/** Maps a Stripe Price ID back to our plan. */
export function planForPriceId(priceId: string | null | undefined): PlanDef["id"] | null {
  if (!priceId) return null;
  const e = env();
  for (const plan of Object.values(PLANS)) {
    if (e[plan.stripePriceEnv] === priceId) return plan.id;
  }
  return null;
}
