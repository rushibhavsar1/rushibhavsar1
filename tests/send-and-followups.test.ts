import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAi } from "@/lib/ai";
import { approveDraft } from "@/server/approvals";
import { refreshDomainStatus, saveSendingSettings } from "@/server/email/settings";
import { fromAddress, textToHtml } from "@/server/email/render";
import { followupDue } from "@/server/jobs/followup";
import { sendDraft } from "@/server/jobs/send-draft";
import { markLeadBooked, markLeadResponded } from "@/server/leads/lifecycle";
import { getOrganization } from "@/server/orgs";
import type { Organization } from "@/server/types";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { fakeAnthropic, scriptedModel } from "./helpers/fake-anthropic";
import { EmailError, FakeMailer, FakeQueue, FakeTelegram } from "./helpers/fakes";
import { createOrgFixture, insertDraft, insertLead } from "./helpers/fixtures";

const NOW = new Date("2026-11-13T10:00:00Z");
const DAY = 86_400_000;

describe("sending and follow-ups", () => {
  let t: TestDatabase;
  let org: Organization;
  let owner: string;
  const queue = new FakeQueue();
  const mailer = new FakeMailer();
  const telegram = new FakeTelegram();

  beforeAll(async () => {
    t = await createTestDb();
    ({ org, userId: owner } = await createOrgFixture(t.db, { name: "Bright Smile" }));
    await t.db.query(
      `update public.organizations set sending_domain = 'mail.brightsmile.com', sending_domain_status = 'verified',
         from_name = 'Maria at Bright Smile', reply_to_email = 'maria@brightsmile.com' where id = $1`,
      [org.id],
    );
    org = (await getOrganization(t.db, org.id))!;
  });
  afterAll(() => t.close());
  beforeEach(() => {
    queue.clear();
    mailer.sent = [];
    mailer.failWith = null;
  });

  const deps = () => ({ db: t.db, queue, mailer, telegram, now: () => NOW });
  const web = () => ({ via: "web" as const, userId: owner });

  async function approvedFirstReply(email = "jane@example.com") {
    const leadId = await insertLead(t.db, org.id, { email, status: "awaiting_approval" });
    const draftId = await insertDraft(t.db, org.id, leadId);
    await approveDraft({ db: t.db, queue: new FakeQueue() }, org.id, draftId, web());
    return { leadId, draftId };
  }

  async function row<T>(sql: string, id: string) {
    return (await t.db.query<T>(sql, [id])).rows[0]!;
  }

  it("sends an approved draft from the org's verified domain and marks the lead replied", async () => {
    const { leadId, draftId } = await approvedFirstReply();
    expect(await sendDraft(deps(), { draftId, orgId: org.id })).toBe("sent");

    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0]!;
    expect(email.from).toBe('"Maria at Bright Smile" <hello@mail.brightsmile.com>');
    expect(email.to).toBe("jane@example.com");
    expect(email.replyTo).toBe("maria@brightsmile.com");
    expect(email.idempotencyKey).toBe(`draft-${draftId}`);
    expect(email.headers?.["Message-ID"]).toBe(`<${draftId}@mail.brightsmile.com>`);
    expect(email.html).toContain('<a href="https://cal.com/brightsmile/intro">');

    expect(await row<{ status: string; resend_email_id: string }>("select status, resend_email_id from public.drafts where id = $1", draftId)).toEqual({
      status: "sent",
      resend_email_id: "re_1",
    });
    const lead = await row<{ status: string; first_replied_at: Date }>(
      "select status, first_replied_at from public.leads where id = $1",
      leadId,
    );
    expect(lead.status).toBe("replied");
    expect(lead.first_replied_at.toISOString()).toBe(NOW.toISOString());

    // Follow-ups scheduled for day 2 and day 5.
    const followups = queue.ofType("followup_due");
    expect(followups.map((f) => [f.data.kind, f.options?.startAfter?.getTime()])).toEqual([
      ["followup_1", NOW.getTime() + 2 * DAY],
      ["followup_2", NOW.getTime() + 5 * DAY],
    ]);

    // Retrying the job does not send twice.
    expect(await sendDraft(deps(), { draftId, orgId: org.id })).toBe("already_sent");
    expect(mailer.sent).toHaveLength(1);
  });

  it("never sends a draft that was not approved", async () => {
    const leadId = await insertLead(t.db, org.id);
    for (const status of ["pending_approval", "rejected", "cancelled"]) {
      const draftId = await insertDraft(t.db, org.id, leadId, { status, kind: status === "pending_approval" ? "first_reply" : "followup_1" });
      expect(await sendDraft(deps(), { draftId, orgId: org.id })).toBe("not_approved");
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it("does not send until the sending domain is verified, then retries", async () => {
    const other = (await createOrgFixture(t.db)).org;
    const leadId = await insertLead(t.db, other.id);
    const draftId = await insertDraft(t.db, other.id, leadId);
    await approveDraft({ db: t.db, queue: new FakeQueue() }, other.id, draftId, web());
    expect(await sendDraft(deps(), { draftId, orgId: other.id })).toBe("domain_not_verified");
    expect(mailer.sent).toHaveLength(0);
    expect((await row<{ send_error: string }>("select send_error from public.drafts where id = $1", draftId)).send_error).toMatch(
      /not verified/,
    );

    // Owner adds a domain; Resend returns DNS records; later it verifies.
    const saved = await saveSendingSettings(t.db, mailer, other, {
      sending_domain: "Mail.Other.com",
      from_local_part: "hello",
    });
    expect(saved).toMatchObject({ sending_domain: "mail.other.com", resend_domain_id: "dom_mail.other.com", sending_domain_status: "pending" });
    mailer.domainStatus = "verified";
    await refreshDomainStatus({ db: t.db, mailer, queue }, saved);
    expect(queue.ofType("send_draft")).toEqual([expect.objectContaining({ data: { draftId, orgId: other.id } })]);
    mailer.domainStatus = "pending";
  });

  it("records permanent send failures and retries transient ones", async () => {
    const { draftId } = await approvedFirstReply("bounce@example.com");
    mailer.failWith = new EmailError("Invalid `to` field", false);
    expect(await sendDraft(deps(), { draftId, orgId: org.id })).toBe("failed");
    mailer.failWith = new EmailError("rate limited", true);
    await expect(sendDraft(deps(), { draftId, orgId: org.id })).rejects.toThrow("rate limited");
  });

  describe("followup_due", () => {
    async function repliedLead(email: string) {
      const { leadId, draftId } = await approvedFirstReply(email);
      await sendDraft(deps(), { draftId, orgId: org.id });
      queue.clear();
      return leadId;
    }
    const ai = () => createAi({ db: t.db, client: fakeAnthropic(scriptedModel()).client });

    it("drafts a follow-up that waits for approval, in the same thread", async () => {
      const leadId = await repliedLead("f1@example.com");
      expect(await followupDue({ db: t.db, ai: ai(), queue }, { leadId, orgId: org.id, kind: "followup_1" })).toBe("drafted");
      const draft = await row<{ status: string; subject: string; kind: string }>(
        "select status, subject, kind from public.drafts where lead_id = $1 and kind = 'followup_1'",
        leadId,
      );
      expect(draft).toEqual({ status: "pending_approval", subject: "Re: Teeth whitening next week", kind: "followup_1" });
      expect(queue.ofType("notify_owner")).toHaveLength(1);
      expect(queue.ofType("send_draft")).toHaveLength(0);
    });

    it("is skipped when the lead replied or booked", async () => {
      const replied = await repliedLead("f2@example.com");
      await markLeadResponded(t.db, org.id, replied, "web");
      expect(await followupDue({ db: t.db, ai: ai(), queue }, { leadId: replied, orgId: org.id, kind: "followup_1" })).toBe("stopped");

      const booked = await repliedLead("f3@example.com");
      await markLeadBooked(t.db, org.id, booked, { uid: "cal_1" });
      expect(await followupDue({ db: t.db, ai: ai(), queue }, { leadId: booked, orgId: org.id, kind: "followup_2" })).toBe("stopped");
      expect(queue.jobs).toHaveLength(0);
    });

    it("day-5 follow-up replaces an unanswered day-2 draft", async () => {
      const leadId = await repliedLead("f4@example.com");
      await followupDue({ db: t.db, ai: ai(), queue }, { leadId, orgId: org.id, kind: "followup_1" });
      await followupDue({ db: t.db, ai: ai(), queue }, { leadId, orgId: org.id, kind: "followup_2" });
      const { rows } = await t.db.query<{ kind: string; status: string }>(
        "select kind, status from public.drafts where lead_id = $1 and kind <> 'first_reply' order by kind",
        [leadId],
      );
      expect(rows).toEqual([
        { kind: "followup_1", status: "cancelled" },
        { kind: "followup_2", status: "pending_approval" },
      ]);
    });

    it("an approved follow-up is not sent if the lead books before it goes out", async () => {
      const leadId = await repliedLead("f5@example.com");
      await followupDue({ db: t.db, ai: ai(), queue }, { leadId, orgId: org.id, kind: "followup_1" });
      const { id } = await row<{ id: string }>("select id from public.drafts where lead_id = $1 and kind = 'followup_1'", leadId);
      await approveDraft({ db: t.db, queue }, org.id, id, web());
      // Booking arrives between approval and the send job.
      await t.db.query("update public.leads set status = 'booked', booked_at = now() where id = $1", [leadId]);
      mailer.sent = [];
      expect(await sendDraft(deps(), { draftId: id, orgId: org.id })).toBe("cancelled");
      expect(mailer.sent).toHaveLength(0);
    });

    it("follow-up emails thread under the first reply", async () => {
      const leadId = await repliedLead("f6@example.com");
      await followupDue({ db: t.db, ai: ai(), queue }, { leadId, orgId: org.id, kind: "followup_1" });
      const first = await row<{ id: string }>("select id from public.drafts where lead_id = $1 and kind = 'first_reply'", leadId);
      const fu = await row<{ id: string }>("select id from public.drafts where lead_id = $1 and kind = 'followup_1'", leadId);
      await approveDraft({ db: t.db, queue }, org.id, fu.id, web());
      mailer.sent = [];
      expect(await sendDraft(deps(), { draftId: fu.id, orgId: org.id })).toBe("sent");
      expect(mailer.sent[0]!.headers?.["In-Reply-To"]).toBe(`<${first.id}@mail.brightsmile.com>`);
      expect(queue.ofType("followup_due")).toHaveLength(0); // only first replies schedule follow-ups
    });
  });
});

describe("email rendering", () => {
  it("escapes HTML and links only https URLs", () => {
    const html = textToHtml('Hi <b>Jane</b> & co.\n\nBook: https://cal.com/x.\njavascript:alert(1)');
    expect(html).toContain("Hi &lt;b&gt;Jane&lt;/b&gt; &amp; co.");
    expect(html).toContain('<a href="https://cal.com/x">https://cal.com/x</a>.');
    expect(html).not.toContain('href="javascript');
  });

  it("sanitises the sender display name", () => {
    expect(
      fromAddress({ name: 'Evil" <x@y.z>\r\nBcc: a@b.c', from_name: null, from_local_part: "hi", sending_domain: "d.com" }),
    ).toBe('"Evil x@y.zBcc: a@b.c" <hi@d.com>');
  });
});
