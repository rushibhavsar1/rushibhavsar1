import type Stripe from "stripe";
import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Queue } from "@/lib/queue";
import type { StripeLike } from "@/lib/stripe";
import { handleStripeEvent } from "@/server/billing/service";
import { BodyTooLargeError, json, readBodyText } from "@/server/http/request";
import { claimWebhookEvent, releaseWebhookEvent } from "@/server/webhooks/idempotency";

/** POST /api/webhooks/stripe — verifies the Stripe-Signature header before doing anything. */
export async function handleStripeWebhook(
  req: Request,
  deps: { db: Db; queue: Queue; stripe: StripeLike; secret: string },
): Promise<Response> {
  let raw: string;
  try {
    raw = await readBodyText(req, 512 * 1024);
  } catch (err) {
    return json({ error: err instanceof BodyTooLargeError ? "too large" : "bad request" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(raw, req.headers.get("stripe-signature") ?? "", deps.secret);
  } catch {
    return json({ error: "invalid signature" }, { status: 400 });
  }

  if (!(await claimWebhookEvent(deps.db, "stripe", event.id))) return json({ received: true, duplicate: true });
  try {
    const result = await handleStripeEvent(deps, event);
    logger.info("stripe event", { type: event.type, id: event.id, result });
    return json({ received: true, result });
  } catch (err) {
    await releaseWebhookEvent(deps.db, "stripe", event.id);
    logger.error("stripe event failed", { err, type: event.type, id: event.id });
    return json({ error: "processing failed" }, { status: 500 }); // Stripe retries
  }
}
