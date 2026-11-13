import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { escapeHtml, type Telegram } from "@/lib/telegram";
import { recordEvent } from "@/server/events";
import { BodyTooLargeError, json, readBodyText } from "@/server/http/request";
import { markLeadBooked } from "@/server/leads/lifecycle";
import { getOrganizationByKey } from "@/server/orgs";
import { claimWebhookEvent, releaseWebhookEvent } from "@/server/webhooks/idempotency";

/** Cal.com signs the raw body with HMAC-SHA256 (hex) in X-Cal-Signature-256. */
export function verifyCalcomSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const given = header.trim().replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(given.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
}

const attendee = z.object({ email: z.string().max(254), name: z.string().max(200).optional() });
const calcomEvent = z.object({
  triggerEvent: z.string().max(60),
  createdAt: z.string().optional(),
  payload: z
    .object({
      uid: z.string().max(200).optional(),
      bookingId: z.union([z.number(), z.string()]).optional(),
      title: z.string().max(500).optional(),
      startTime: z.string().max(60).optional(),
      attendees: z.array(attendee).max(50).optional(),
      responses: z.object({ email: z.object({ value: z.string().max(254) }).optional() }).loose().optional(),
    })
    .loose()
    .optional(),
});

const BOOKED_EVENTS = new Set(["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_PAID"]);

export interface CalcomDeps {
  db: Db;
  telegram: Telegram | null;
  onCancelledDrafts?: (orgId: string, draftIds: string[]) => Promise<void>;
}

/** POST /api/webhooks/calcom/:orgKey */
export async function handleCalcomWebhook(req: Request, orgKey: string, deps: CalcomDeps): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(orgKey)) return json({ error: "not found" }, { status: 404 });

  let raw: string;
  try {
    raw = await readBodyText(req, 256 * 1024);
  } catch (err) {
    return json({ error: err instanceof BodyTooLargeError ? "too large" : "bad request" }, { status: 400 });
  }

  const org = await getOrganizationByKey(deps.db, orgKey);
  if (!org) return json({ error: "not found" }, { status: 404 });
  if (!verifyCalcomSignature(raw, req.headers.get("x-cal-signature-256"), org.calcom_webhook_secret)) {
    logger.warn("calcom signature mismatch", { orgId: org.id });
    return json({ error: "invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad json" }, { status: 400 });
  }
  const parsed = calcomEvent.safeParse(body);
  if (!parsed.success) return json({ ok: true, ignored: "unrecognised payload" });
  const event = parsed.data;

  if (!BOOKED_EVENTS.has(event.triggerEvent) || !event.payload) {
    return json({ ok: true, ignored: event.triggerEvent });
  }
  const p = event.payload;
  const eventId = `${org.id}:${event.triggerEvent}:${p.uid ?? p.bookingId ?? event.createdAt ?? raw.length}`;
  if (!(await claimWebhookEvent(deps.db, "calcom", eventId))) return json({ ok: true, duplicate: true });

  try {
    const emails = Array.from(
      new Set(
        [...(p.attendees ?? []).map((a) => a.email), p.responses?.email?.value]
          .filter((e): e is string => typeof e === "string" && e.includes("@"))
          .map((e) => e.trim().toLowerCase()),
      ),
    );
    if (emails.length === 0) return json({ ok: true, ignored: "no attendee email" });

    const { rows } = await deps.db.query<{ id: string; name: string | null; email: string }>(
      `select id, name, email from public.leads
        where org_id = $1 and lower(email) = any($2::text[])
        order by created_at desc limit 1`,
      [org.id, emails],
    );
    const lead = rows[0];
    if (!lead) {
      await recordEvent(deps.db, org.id, "booking_unmatched", { emails, uid: p.uid ?? null });
      return json({ ok: true, matched: false });
    }

    const cancelled = await markLeadBooked(deps.db, org.id, lead.id, {
      trigger: event.triggerEvent,
      uid: p.uid ?? null,
      start_time: p.startTime ?? null,
      title: p.title ?? null,
    });
    if (cancelled.length && deps.onCancelledDrafts) await deps.onCancelledDrafts(org.id, cancelled);

    if (deps.telegram && org.telegram_chat_id) {
      const when = p.startTime ? ` for ${escapeHtml(new Date(p.startTime).toUTCString())}` : "";
      await deps.telegram
        .sendMessage(org.telegram_chat_id, `📅 <b>${escapeHtml(lead.name ?? lead.email)}</b> booked a call${when}. Follow-ups stopped.`)
        .catch((err) => logger.warn("telegram booking notice failed", { err }));
    }
    return json({ ok: true, matched: true, leadId: lead.id });
  } catch (err) {
    await releaseWebhookEvent(deps.db, "calcom", eventId);
    throw err;
  }
}
