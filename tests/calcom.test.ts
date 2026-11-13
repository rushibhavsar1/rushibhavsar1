import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleCalcomWebhook, verifyCalcomSignature } from "@/server/webhooks/calcom";
import type { Organization } from "@/server/types";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { FakeTelegram } from "./helpers/fakes";
import { createOrgFixture, insertDraft, insertLead } from "./helpers/fixtures";

function booking(email: string, uid = `uid-${Math.random()}`, trigger = "BOOKING_CREATED") {
  return JSON.stringify({
    triggerEvent: trigger,
    createdAt: "2026-11-13T10:00:00.000Z",
    payload: {
      uid,
      title: "Intro call",
      startTime: "2026-11-20T09:00:00.000Z",
      attendees: [{ email, name: "Jane", timeZone: "Europe/London" }],
      organizer: { email: "owner@biz.com" },
    },
  });
}

function signed(orgKey: string, body: string, secret: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-cal-signature-256"] = createHmac("sha256", secret).update(body).digest("hex");
  return new Request(`http://localhost/api/webhooks/calcom/${orgKey}`, { method: "POST", headers, body });
}

describe("Cal.com bookings webhook", () => {
  let t: TestDatabase;
  let org: Organization;
  const telegram = new FakeTelegram();
  const deps = () => ({ db: t.db, telegram });

  beforeAll(async () => {
    t = await createTestDb();
    org = (await createOrgFixture(t.db)).org;
    await t.db.query("update public.organizations set telegram_chat_id = 77 where id = $1", [org.id]);
  });
  afterAll(() => t.close());
  beforeEach(() => telegram.clear());

  it("verifies the HMAC signature", () => {
    const body = booking("x@y.z");
    const sig = createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyCalcomSignature(body, sig, "secret")).toBe(true);
    expect(verifyCalcomSignature(body, `sha256=${sig}`, "secret")).toBe(true);
    expect(verifyCalcomSignature(body + " ", sig, "secret")).toBe(false);
    expect(verifyCalcomSignature(body, sig, "other")).toBe(false);
    expect(verifyCalcomSignature(body, null, "secret")).toBe(false);
    expect(verifyCalcomSignature(body, "zz", "secret")).toBe(false);
  });

  it("matches the booking to the lead by email, marks it booked and cancels pending follow-ups", async () => {
    const leadId = await insertLead(t.db, org.id, { email: "jane@example.com", status: "replied" });
    const followup = await insertDraft(t.db, org.id, leadId, { kind: "followup_1" });

    const res = await handleCalcomWebhook(
      signed(org.org_key, booking("Jane@Example.com"), org.calcom_webhook_secret),
      org.org_key,
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: true, leadId });

    const lead = await t.db.query<{ status: string; booked_at: Date | null; followups_stopped_at: Date | null }>(
      "select status, booked_at, followups_stopped_at from public.leads where id = $1",
      [leadId],
    );
    expect(lead.rows[0]!.status).toBe("booked");
    expect(lead.rows[0]!.booked_at).toBeInstanceOf(Date);
    expect(lead.rows[0]!.followups_stopped_at).toBeInstanceOf(Date);
    const draft = await t.db.query<{ status: string }>("select status from public.drafts where id = $1", [followup]);
    expect(draft.rows[0]!.status).toBe("cancelled");
    expect(telegram.sent()[0]!.text).toContain("booked a call");
  });

  it("rejects bad signatures and does not touch the lead", async () => {
    const leadId = await insertLead(t.db, org.id, { email: "bob@example.com", status: "replied" });
    const body = booking("bob@example.com");
    expect((await handleCalcomWebhook(signed(org.org_key, body, null), org.org_key, deps())).status).toBe(401);
    expect((await handleCalcomWebhook(signed(org.org_key, body, "wrong-secret"), org.org_key, deps())).status).toBe(401);
    // Another org's secret does not work either.
    const other = (await createOrgFixture(t.db)).org;
    expect(
      (await handleCalcomWebhook(signed(org.org_key, body, other.calcom_webhook_secret), org.org_key, deps())).status,
    ).toBe(401);
    const lead = await t.db.query<{ status: string }>("select status from public.leads where id = $1", [leadId]);
    expect(lead.rows[0]!.status).toBe("replied");
  });

  it("only matches leads of the org the webhook belongs to", async () => {
    const other = (await createOrgFixture(t.db)).org;
    const otherLead = await insertLead(t.db, other.id, { email: "shared@example.com", status: "replied" });
    const res = await handleCalcomWebhook(
      signed(org.org_key, booking("shared@example.com"), org.calcom_webhook_secret),
      org.org_key,
      deps(),
    );
    expect(await res.json()).toMatchObject({ matched: false });
    const lead = await t.db.query<{ status: string }>("select status from public.leads where id = $1", [otherLead]);
    expect(lead.rows[0]!.status).toBe("replied");
  });

  it("is idempotent for repeated deliveries and ignores other triggers", async () => {
    await insertLead(t.db, org.id, { email: "dup@example.com", status: "replied" });
    const body = booking("dup@example.com", "same-uid");
    const first = await handleCalcomWebhook(signed(org.org_key, body, org.calcom_webhook_secret), org.org_key, deps());
    const second = await handleCalcomWebhook(signed(org.org_key, body, org.calcom_webhook_secret), org.org_key, deps());
    expect(await first.json()).toMatchObject({ matched: true });
    expect(await second.json()).toMatchObject({ duplicate: true });

    const ping = JSON.stringify({ triggerEvent: "PING", payload: {} });
    const res = await handleCalcomWebhook(signed(org.org_key, ping, org.calcom_webhook_secret), org.org_key, deps());
    expect(await res.json()).toMatchObject({ ignored: "PING" });
  });
});
