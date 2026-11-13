import type { PlanId, SubscriptionStatus } from "@/server/types";

export interface PlanDef {
  id: Exclude<PlanId, "none">;
  name: string;
  /** Leads processed by AI per calendar month (UTC). */
  monthlyLeadLimit: number;
  /** Hard cap on Anthropic spend per calendar month (UTC), in USD. */
  monthlyAiCapUsd: number;
  /** Shown on the billing page. The real price lives in Stripe. */
  priceLabel: string;
  stripePriceEnv: "STRIPE_PRICE_STARTER" | "STRIPE_PRICE_GROWTH" | "STRIPE_PRICE_PRO";
}

export const PLANS: Record<PlanDef["id"], PlanDef> = {
  starter: {
    id: "starter",
    name: "Starter",
    monthlyLeadLimit: 100,
    monthlyAiCapUsd: 10,
    priceLabel: "$49/month",
    stripePriceEnv: "STRIPE_PRICE_STARTER",
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyLeadLimit: 500,
    monthlyAiCapUsd: 40,
    priceLabel: "$129/month",
    stripePriceEnv: "STRIPE_PRICE_GROWTH",
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyLeadLimit: 2000,
    monthlyAiCapUsd: 150,
    priceLabel: "$299/month",
    stripePriceEnv: "STRIPE_PRICE_PRO",
  },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanDef["id"][];

export function isPlanId(value: string): value is PlanDef["id"] {
  return value in PLANS;
}

export function planLimits(plan: PlanId): { monthlyLeadLimit: number; monthlyAiCapUsd: number } {
  if (plan === "none") return { monthlyLeadLimit: 0, monthlyAiCapUsd: 0 };
  const def = PLANS[plan];
  return { monthlyLeadLimit: def.monthlyLeadLimit, monthlyAiCapUsd: def.monthlyAiCapUsd };
}

/** Subscription states that count as paid. */
export function isPaidStatus(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

/** AI processing is only allowed for orgs with a paid (or trialing) subscription. */
export function billingAllowsAi(org: { plan: PlanId; subscription_status: SubscriptionStatus }): boolean {
  return org.plan !== "none" && isPaidStatus(org.subscription_status);
}
