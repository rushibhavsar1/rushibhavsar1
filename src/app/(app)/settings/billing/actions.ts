"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isPlanId } from "@/lib/plans";
import { getStripe } from "@/lib/stripe";
import { requireOrgAdmin } from "@/server/auth/context";
import { createCheckoutSession, createPortalSession } from "@/server/billing/service";

export async function startCheckout(formData: FormData): Promise<void> {
  const ctx = await requireOrgAdmin();
  const plan = String(formData.get("plan") ?? "");
  if (!isPlanId(plan)) redirect("/settings/billing?error=plan");
  let url: string;
  try {
    url = await createCheckoutSession({ db: getDb(), stripe: getStripe() }, ctx.org, plan, ctx.user.email ?? null);
  } catch (err) {
    logger.error("checkout failed", { err, orgId: ctx.org.id });
    redirect("/settings/billing?error=checkout");
  }
  redirect(url);
}

export async function openBillingPortal(): Promise<void> {
  const ctx = await requireOrgAdmin();
  let url: string;
  try {
    url = await createPortalSession(getStripe(), ctx.org);
  } catch (err) {
    logger.error("portal failed", { err, orgId: ctx.org.id });
    redirect("/settings/billing?error=portal");
  }
  redirect(url);
}
