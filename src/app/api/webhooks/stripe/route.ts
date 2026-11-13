import { getDb } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { getQueue } from "@/lib/queue";
import { getStripe } from "@/lib/stripe";
import { handleStripeWebhook } from "@/server/webhooks/stripe";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleStripeWebhook(request, {
    db: getDb(),
    queue: getQueue(),
    stripe: getStripe(),
    secret: requireEnv("STRIPE_WEBHOOK_SECRET"),
  });
}
